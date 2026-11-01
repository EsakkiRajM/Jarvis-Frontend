import { useCallback, useEffect, useRef, useState } from "react";
//import { checkHealth, sendMessage } from "../api.js";
import "./App.css";
import axios from "axios";

const SpeechRecognition =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : undefined;

const MAX_HISTORY = 50;
const ECHO_COOLDOWN_MS = 700; // ignore mic briefly after JARVIS stops talking
const HEALTH_INTERVAL_MS = 30000;
const VOICE_THRESHOLD = 0.035;

// Errors where restarting the recognizer would just loop forever.
const FATAL_RECOGNITION_ERRORS = {
  "not-allowed": "Microphone permission was denied.",
  "service-not-allowed": "Speech recognition is blocked in this browser.",
  "audio-capture": "No microphone was found.",
  network:
    "Speech recognition needs an internet connection in this browser.",
};

const STATUS_LABEL = {
  speaking: "SPEAKING",
  listening: "LISTENING",
  thinking: "PROCESSING",
  error: "ATTENTION REQUIRED",
  idle: "SYSTEM ONLINE",
};

const CAPTION_LABEL = {
  listening: "VOICE DETECTED",
  speaking: "TRANSMITTING VOICE",
  thinking: "PROCESSING",
  error: "CHECK SYSTEM",
  idle: "NEURAL CORE",
};

// Quick answers handled in the browser. Everything else goes to the backend.
const getLocalReply = async (input) => {
  const text = input.toLowerCase().trim();

  if (/^(hello|hi|hey)( jarvis)?\b/.test(text)) {
    return "Hello Esakki. All systems are operational.";
  }
  if (/\b(what('s| is) your name|who are you)\b/.test(text)) {
    return "I am JARVIS, your personal AI assistant.";
  }
  if (/\b(how many users are connected)\b/.test(text)) {
    try {
    const users = await axios.get(`http://localhost:8000/users`)
    if (users.data) {
      console.log(users.data.users)
    }
    return `Owner of the jarvis Mr. ${users.data.users[0][1]}`;
    } catch (error) {
      console.error("Error fetching users:", error);
      return "Unable to retrieve user information.";
    }
    
  
  }
  if (/\b(system status|status report)\b/.test(text)) {
    return "JARVIS is online and ready to assist you.";
  }
  if (/\b(what('s| is) the time|current time|what time is it)\b/.test(text)) {
    return `The current time is ${new Date().toLocaleTimeString()}.`;
  }

  return null;
}

export default function App() {
  const [mode, setMode] = useState("idle");
  const [level, setLevel] = useState(0);
  const [command, setCommand] = useState("");
  const [interim, setInterim] = useState("");
  const [reply, setReply] = useState("Systems online. How may I assist you?");
  const [history, setHistory] = useState([]);
  const [micEnabled, setMicEnabled] = useState(false);
  const [backendStatus, setBackendStatus] = useState("checking");

  const audioContextRef = useRef(null);
  const streamRef = useRef(null);
  const animationRef = useRef(null);
  const recognitionRef = useRef(null);
  const restartTimerRef = useRef(null);
  const utteranceRef = useRef(null);
  const voicesRef = useRef([]);
  const abortRef = useRef(null);
  const lastLevelRef = useRef(0);
  const idRef = useRef(0);
  const ignoreUntilRef = useRef(0);

  const listeningRef = useRef(false);
  const startingRef = useRef(false);
  // True from the moment a command is received until JARVIS finishes speaking.
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  const addHistory = useCallback((role, text) => {
    const id = ++idRef.current;
    setHistory((previous) =>
      [...previous, { id, role, text }].slice(-MAX_HISTORY)
    );
  }, []);

  // ---------- Microphone level -> orb animation ----------

  const startAudioVisualizer = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("Microphone access requires localhost or HTTPS.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });

      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      streamRef.current = stream;

      const AudioContextClass =
        window.AudioContext || window.webkitAudioContext;

      const audioContext = new AudioContextClass();
      audioContextRef.current = audioContext;
      await audioContext.resume();

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);

      const data = new Uint8Array(analyser.frequencyBinCount);

      const animate = () => {
        if (!mountedRef.current) return;

        analyser.getByteTimeDomainData(data);

        let sum = 0;
        for (const sample of data) {
          const normalized = (sample - 128) / 128;
          sum += normalized * normalized;
        }

        const volume = Math.min(1, Math.sqrt(sum / data.length) * 5);

        // Only re-render when the level visibly changes (not 60x per second).
        const rounded = Math.round(volume * 50) / 50;
        if (rounded !== lastLevelRef.current) {
          lastLevelRef.current = rounded;
          setLevel(rounded);
        }

        // Never overwrite "thinking" / "speaking" with listening/idle.
        if (!busyRef.current && listeningRef.current) {
          setMode(volume > VOICE_THRESHOLD ? "listening" : "idle");
        }

        animationRef.current = requestAnimationFrame(animate);
      };

      animate();
      setMicEnabled(true);
      return true;
    } catch (error) {
      console.error("Microphone error:", error);
      setReply(error.message || "Unable to access the microphone.");
      setMode("error");
      return false;
    }
  }, []);

  const stopAudioVisualizer = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);
      audioContextRef.current = null;
    }

    lastLevelRef.current = 0;
    setMicEnabled(false);
    setLevel(0);
  }, []);

  // ---------- Speech output ----------

  const finishSpeaking = useCallback(() => {
    busyRef.current = false;
    ignoreUntilRef.current = Date.now() + ECHO_COOLDOWN_MS;
    if (mountedRef.current) setMode("idle");
  }, []);

  const speak = useCallback(
    (text) => {
      const synth = window.speechSynthesis;

      if (!synth) {
        finishSpeaking();
        return;
      }

      synth.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 0.85;
      utterance.volume = 1;

      const preferredVoice = voicesRef.current.find(
        (voice) =>
          /en/i.test(voice.lang) && /Microsoft|Google/i.test(voice.name)
      );
      if (preferredVoice) utterance.voice = preferredVoice;

      // Keep a reference: Chrome can garbage-collect utterances and never
      // fire onend. Also lets us ignore events from a cancelled utterance.
      utteranceRef.current = utterance;

      utterance.onstart = () => {
        if (utteranceRef.current === utterance && mountedRef.current) {
          setMode("speaking");
        }
      };

      const done = () => {
        if (utteranceRef.current !== utterance) return;
        utteranceRef.current = null;
        finishSpeaking();
      };

      utterance.onend = done;
      utterance.onerror = done;

      synth.speak(utterance);
    },
    [finishSpeaking]
  );

  // ---------- Command handling (local first, then Python backend) ----------

  const processCommand = useCallback(
    async (text) => {
      const input = text.trim();
      if (!input) return;

      // A new command replaces any request or speech still in progress.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      utteranceRef.current = null;
      window.speechSynthesis?.cancel();
      busyRef.current = true;

      addHistory("you", input);
      setInterim("");
      setMode("thinking");

      let response = await getLocalReply(input);

      if (!response) {
        try {
          response = await sendMessage(input, controller.signal);
          if (mountedRef.current) setBackendStatus("online");
        } catch (error) {
          if (controller.signal.aborted) return; // replaced or stopped

          console.error("Backend error:", error);
          if (mountedRef.current) setBackendStatus("offline");

          response =
            error.userMessage ??
            "Something went wrong while contacting my AI core.";
        }
      }

      if (controller.signal.aborted || !mountedRef.current) return;

      setReply(response);
      addHistory("jarvis", response);
      speak(response);
    },
    [addHistory, speak]
  );

  // ---------- Start / stop listening ----------

  const stopListening = useCallback(
    (message, isError = false) => {
      listeningRef.current = false;
      startingRef.current = false;
      clearTimeout(restartTimerRef.current);

      const recognition = recognitionRef.current;
      recognitionRef.current = null;

      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
          recognition.abort();
        } catch {
          // Already stopped.
        }
      }

      abortRef.current?.abort();
      abortRef.current = null;
      utteranceRef.current = null;
      window.speechSynthesis?.cancel();
      busyRef.current = false;

      stopAudioVisualizer();
      setInterim("");
      setMode(isError ? "error" : "idle");
      setReply(message ?? "Microphone disabled. JARVIS is standing by.");
    },
    [stopAudioVisualizer]
  );

  const startListening = useCallback(async () => {
    if (listeningRef.current || startingRef.current) return;

    if (!SpeechRecognition) {
      setReply(
        "Speech recognition is unavailable in this browser. " +
          "Use Chrome or Edge, or type your command below."
      );
      setMode("error");
      return;
    }

    startingRef.current = true;

    try {
      const micReady = await startAudioVisualizer();
      if (!micReady || !mountedRef.current) return;

      const recognition = new SpeechRecognition();
      recognition.lang = "en-IN";
      recognition.continuous = true;
      recognition.interimResults = true;

      recognition.onresult = (event) => {
        // Ignore anything heard while JARVIS is busy: it would be JARVIS's
        // own voice coming out of the speakers.
        if (busyRef.current || Date.now() < ignoreUntilRef.current) {
          setInterim("");
          return;
        }

        let finalText = "";
        let interimText = "";

        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal) {
            finalText += result[0].transcript;
          } else {
            interimText += result[0].transcript;
          }
        }

        setInterim(interimText);

        if (finalText.trim()) {
          processCommand(finalText);
        }
      };

      recognition.onerror = (event) => {
        if (event.error === "no-speech" || event.error === "aborted") return;

        console.warn("Speech recognition:", event.error);

        const message = FATAL_RECOGNITION_ERRORS[event.error];
        if (message) stopListening(message, true);
      };

      recognition.onend = () => {
        if (!listeningRef.current || !mountedRef.current) return;

        // Chrome ends the session after silence. Restart after a short delay
        // to avoid a tight start/stop loop.
        restartTimerRef.current = setTimeout(() => {
          if (!listeningRef.current || recognitionRef.current !== recognition) {
            return;
          }
          try {
            recognition.start();
          } catch {
            // Already running.
          }
        }, 250);
      };

      recognitionRef.current = recognition;
      listeningRef.current = true;
      recognition.start();

      setMode("listening");
      setReply("Listening. Speak your command.");
    } catch (error) {
      console.error(error);
      stopListening("Unable to start speech recognition.", true);
    } finally {
      startingRef.current = false;
    }
  }, [processCommand, startAudioVisualizer, stopListening]);

  const submitText = (event) => {
    event.preventDefault();
    const text = command.trim();
    if (!text) return;
    setCommand("");
    processCommand(text);
  };

  // ---------- Effects ----------

  // Voices load asynchronously in Chrome; wait for them.
  useEffect(() => {
    const synth = window.speechSynthesis;
    if (!synth) return;

    const loadVoices = () => {
      voicesRef.current = synth.getVoices();
    };

    loadVoices();
    synth.addEventListener("voiceschanged", loadVoices);
    return () => synth.removeEventListener("voiceschanged", loadVoices);
  }, []);

  // Check that the Python backend is reachable.
  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const online = await checkHealth();
      if (!cancelled) setBackendStatus(online ? "online" : "offline");
    };

    run();
    const timer = setInterval(run, HEALTH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Release everything on unmount.
  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
      listeningRef.current = false;
      clearTimeout(restartTimerRef.current);
      abortRef.current?.abort();

      const recognition = recognitionRef.current;
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onend = null;
        try {
          recognition.abort();
        } catch {
          // Already stopped.
        }
        recognitionRef.current = null;
      }

      utteranceRef.current = null;
      window.speechSynthesis?.cancel();

      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
    };
  }, []);

  // ---------- UI ----------

  const backendClass =
    backendStatus === "online"
      ? "healthy"
      : backendStatus === "offline"
        ? "offline"
        : "muted";

  const backendLabel =
    backendStatus === "online"
      ? "● ONLINE"
      : backendStatus === "offline"
        ? "● OFFLINE"
        : "○ CHECKING";

  return (
    <main className="jarvis-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">J</span>
          <div>
            <h1>J.A.R.V.I.S.</h1>
            <span className="brand-subtitle">PERSONAL INTELLIGENCE SYSTEM</span>
          </div>
        </div>

        <div className="system-status">
          <span className={`status-dot ${mode}`} />
          {STATUS_LABEL[mode] ?? STATUS_LABEL.idle}
        </div>
      </header>

      <section className="main-stage">
        <div className="side-panel left-panel">
          <div className="panel-label">VOICE INTERFACE</div>

          <div className="metric">
            <span>INPUT LEVEL</span>
            <strong>{Math.round(level * 100)}%</strong>
            <div className="level-track">
              <div
                className="level-fill"
                style={{ width: `${level * 100}%` }}
              />
            </div>
          </div>

          <div className="metric">
            <span>MICROPHONE</span>
            <strong>{micEnabled ? "ACTIVE" : "STANDBY"}</strong>
          </div>

          <div className="equalizer" aria-hidden="true">
            {Array.from({ length: 20 }, (_, i) => (
              <span
                key={i}
                style={{
                  height: `${5 + level * (10 + ((i * 7) % 24))}px`,
                }}
              />
            ))}
          </div>
        </div>

        <div
          className={`orb-scene mode-${mode}`}
          style={{ "--voice-level": level }}
        >
          <div className="orbit orbit-outer">
            <span className="orbit-marker marker-one" />
            <span className="orbit-marker marker-two" />
          </div>

          <div className="orbit orbit-middle">
            <span className="orbit-marker marker-three" />
          </div>

          <div className="orbit orbit-inner">
            <span className="orbit-marker marker-four" />
          </div>

          <div className="energy-ring ring-one" />
          <div className="energy-ring ring-two" />
          <div className="energy-ring ring-three" />

          <div className="orb-core">
            <div className="orb-inner">
              <div className="orb-highlight" />
            </div>
          </div>

          {Array.from({ length: 24 }, (_, i) => (
            <span
              key={i}
              className="particle"
              style={{
                "--i": i,
                "--angle": `${i * 15}deg`,
                "--distance": `${125 + (i % 4) * 23}px`,
                "--delay": `${(i % 8) * -0.3}s`,
              }}
            />
          ))}

          <div className="orb-caption">
            <span className="caption-line" />
            <span>{CAPTION_LABEL[mode] ?? CAPTION_LABEL.idle}</span>
            <span className="caption-line" />
          </div>
        </div>

        <div className="side-panel right-panel">
          <div className="panel-label">SYSTEM DIAGNOSTICS</div>

          <div className="diagnostic-row">
            <span>CORE</span>
            <span className="healthy">● ONLINE</span>
          </div>

          <div className="diagnostic-row">
            <span>VOICE ENGINE</span>
            <span className={micEnabled ? "healthy" : "muted"}>
              ● {micEnabled ? "ACTIVE" : "READY"}
            </span>
          </div>

          <div className="diagnostic-row">
            <span>AI CONNECTION</span>
            <span className={backendClass}>{backendLabel}</span>
          </div>

          <div className="response-box">
            <div className="panel-label">JARVIS RESPONSE</div>
            <p>{reply}</p>
          </div>
        </div>
      </section>

      <section className="conversation">
        <div className="conversation-heading">
          <span>COMMUNICATION LOG</span>
          <span>{history.length.toString().padStart(2, "0")} ENTRIES</span>
        </div>

        <div className="conversation-log" aria-live="polite">
          {history.length === 0 && !interim ? (
            <p className="empty-log">
              No conversations yet. Activate the microphone to begin.
            </p>
          ) : (
            <>
              {history.slice(-4).map((entry) => (
                <div className={`log-entry ${entry.role}`} key={entry.id}>
                  <span>{entry.role === "you" ? "YOU" : "JARVIS"}</span>
                  <p>{entry.text}</p>
                </div>
              ))}

              {interim && (
                <div className="log-entry you interim">
                  <span>YOU</span>
                  <p>{interim}</p>
                </div>
              )}
            </>
          )}
        </div>

        <form className="command-form" onSubmit={submitText}>
          <span className="input-prefix">&gt;</span>
          <input
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="Enter a command..."
            aria-label="Enter a command"
            autoComplete="off"
          />
          <button type="submit" className="send-button">
            SEND ↗
          </button>
        </form>
      </section>

      <footer className="control-bar">
        <div className="footer-status">
          <span className="status-dot" />
          JARVIS LOCAL INTERFACE
        </div>

        <button
          className={`mic-button ${micEnabled ? "active" : ""}`}
          onClick={() => (micEnabled ? stopListening() : startListening())}
          type="button"
        >
          <span>{micEnabled ? "■" : "🎙"}</span>
          {micEnabled ? "DISCONNECT VOICE" : "ACTIVATE VOICE"}
        </button>

        <div className="footer-version">INTERFACE V1.1</div>
      </footer>
    </main>
  );
}
