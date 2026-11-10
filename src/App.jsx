import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";
import axios from "axios";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";


// ============================================
// CONFIGURATION
// ============================================


const API_URL = import.meta.env.VITE_API_URL
//console.log("API_URL:", API_URL);

if (!API_URL) {
  throw new Error("VITE_API_URL is missing");
}


const MAX_HISTORY = 50;
const ECHO_COOLDOWN_MS = 700;
const HEALTH_INTERVAL_MS = 30000;
const VOICE_THRESHOLD = 0.035;

// ============================================
// SPEECH RECOGNITION
// ============================================

const SpeechRecognition =
  typeof window !== "undefined"
    ? window.SpeechRecognition ||
      window.webkitSpeechRecognition
    : undefined;

// ============================================
// CONSTANTS
// ============================================

const FATAL_RECOGNITION_ERRORS = {
  "not-allowed": "Microphone permission was denied.",
  "service-not-allowed":
    "Speech recognition is blocked in this browser.",
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

// ============================================
// API FUNCTIONS
// ============================================

const checkHealth = async () => {
  try {
    const response = await axios.get(`${API_URL}/`, {
      timeout: 5000,
    });

    return response.data.status === "online";
  } catch (error) {
    console.error("Backend health check:", error);
    return false;
  }
};

const sendMessage = async (message, signal) => {
  try {
    const response = await axios.post(
      `${API_URL}/ask-ai`,
      { message },
      {
        signal,
        timeout: 60000,
      }
    );

    if (!response.data.success) {
      throw new Error(
        response.data.reply || "AI service unavailable"
      );
    }

    console.log("AI Provider:", response.data.provider);

    return response.data.reply;
  } catch (error) {
    console.error("AI API Error:", error);
    throw error;
  }
};

// ============================================
// LOCAL COMMANDS
// ============================================

const getLocalReply = async (input, signal) => {
  const text = input.toLowerCase().trim();

  // Greeting
  if (/^(hello|hi|hey)( jarvis)?\b/.test(text)) {
    return "Hello Esakki. All systems are operational.";
  }

  // Assistant identity
  if (/\b(what('s| is) your name|who are you)\b/.test(text)) {
    return "I am JARVIS, your personal AI assistant.";
  }

  // Owner information
  if (/\b(who is the owner)\b/.test(text)) {
    try {
      const users = await axios.get(`${API_URL}/users`, {
        timeout: 10000,
        signal,
      });

      const user = users.data.users?.[0];

      if (!user) {
        return "Owner information is not available.";
      }

      return `Mr. ${user[1]} ${user[3]} of JARVIS.`;
    } catch (error) {
      if (axios.isCancel(error) || error.code === "ERR_CANCELED") {
        throw error;
      }

      console.error("Error fetching users:", error);

      return "Unable to retrieve user information.";
    }
  }

  // Second owner information
  if (/\b(who is the second owner)\b/.test(text)) {
    try {
      const users = await axios.get(`${API_URL}/users`, {
        timeout: 10000,
        signal,
      });

      const user = users.data.users?.[3];

      if (!user) {
        return "Second owner information is not available.";
      }

      return `Mrs. ${user[1]}.`;
    } catch (error) {
      if (axios.isCancel(error) || error.code === "ERR_CANCELED") {
        throw error;
      }

      console.error("Error fetching users:", error);

      return "Unable to retrieve user information.";
    }
  }

  // System status
  if (/\b(system status|status report)\b/.test(text)) {
    return "JARVIS is online and ready to assist you.";
  }

  // Current time
  if (
    /\b(what('s| is) the time|current time|what time is it)\b/.test(
      text
    )
  ) {
    return `The current time is ${new Date().toLocaleTimeString()}.`;
  }

  return null;
};

// ============================================
// CLEAN MARKDOWN FOR VOICE
// ============================================

const cleanTextForSpeech = (text) => {
  return text
    .replace(/```[\w-]*\n?/g, "")
    .replace(/```/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

// ============================================
// MAIN APP
// ============================================

export default function App() {
  // ============================================
  // STATES
  // ============================================

  const [mode, setMode] = useState("idle");

  const [level, setLevel] = useState(0);

  const [command, setCommand] = useState("");

  const [interim, setInterim] = useState("");

  const [history, setHistory] = useState([]);

  const [micEnabled, setMicEnabled] = useState(false);

  const [backendStatus, setBackendStatus] =
    useState("checking");

  // ============================================
  // REFERENCES
  // ============================================

  const audioContextRef = useRef(null);

  const streamRef = useRef(null);

  const animationRef = useRef(null);

  const recognitionRef = useRef(null);

  const restartTimerRef = useRef(null);

  const utteranceRef = useRef(null);

  const voicesRef = useRef([]);

  const abortRef = useRef(null);

  const pendingMessageIdRef = useRef(null);

  const lastLevelRef = useRef(0);

  const idRef = useRef(0);

  const ignoreUntilRef = useRef(0);

  const conversationLogRef = useRef(null);

  const textareaRef = useRef(null);

  const listeningRef = useRef(false);

  const startingRef = useRef(false);

  const busyRef = useRef(false);

  const mountedRef = useRef(false);

  // ============================================
  // ADD HISTORY
  // ============================================

  const addHistory = useCallback((role, text, status = "complete") => {
    const id = ++idRef.current;

    setHistory((previous) => [
      ...previous,
      {
        id,
        role,
        text,
        status,
      },
    ].slice(-MAX_HISTORY));

    return id;
  }, []);

  // ============================================
  // UPDATE HISTORY
  // ============================================

  const updateHistory = useCallback((id, updates) => {
    setHistory((previous) =>
      previous.map((item) =>
        item.id === id
          ? { ...item, ...updates }
          : item
      )
    );
  }, []);

  // ============================================
  // REMOVE HISTORY
  // ============================================

  const removeHistory = useCallback((id) => {
    setHistory((previous) =>
      previous.filter((item) => item.id !== id)
    );
  }, []);

  // ============================================
  // AUTO SCROLL
  // ============================================

  useEffect(() => {
    const container = conversationLogRef.current;

    if (container) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [history, interim]);

  // ============================================
  // AUDIO VISUALIZER
  // ============================================

  const startAudioVisualizer = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error(
          "Microphone access requires localhost or HTTPS."
        );
      }

      const stream =
        await navigator.mediaDevices.getUserMedia({
          audio: true,
        });

      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return false;
      }

      streamRef.current = stream;

      const AudioContextClass =
        window.AudioContext ||
        window.webkitAudioContext;

      if (!AudioContextClass) {
        throw new Error(
          "Audio visualizer is not supported in this browser."
        );
      }

      const audioContext = new AudioContextClass();

      audioContextRef.current = audioContext;

      await audioContext.resume();

      const analyser = audioContext.createAnalyser();

      analyser.fftSize = 256;

      audioContext
        .createMediaStreamSource(stream)
        .connect(analyser);

      const data = new Uint8Array(
        analyser.frequencyBinCount
      );

      const animate = () => {
        if (!mountedRef.current) return;

        analyser.getByteTimeDomainData(data);

        let sum = 0;

        for (const sample of data) {
          const normalized = (sample - 128) / 128;

          sum += normalized * normalized;
        }

        const volume = Math.min(
          1,
          Math.sqrt(sum / data.length) * 5
        );

        const rounded = Math.round(volume * 50) / 50;

        if (rounded !== lastLevelRef.current) {
          lastLevelRef.current = rounded;

          setLevel(rounded);
        }

        if (!busyRef.current && listeningRef.current) {
          setMode(
            volume > VOICE_THRESHOLD
              ? "listening"
              : "idle"
          );
        }

        animationRef.current =
          requestAnimationFrame(animate);
      };

      animate();

      setMicEnabled(true);

      return true;

    } catch (error) {
      console.error("Microphone error:", error);

      setMode("error");

      return false;
    }
  }, []);

  // ============================================
  // STOP VISUALIZER
  // ============================================

  const stopAudioVisualizer = useCallback(() => {
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);

      animationRef.current = null;
    }

    streamRef.current
      ?.getTracks()
      .forEach((track) => track.stop());

    streamRef.current = null;

    if (audioContextRef.current) {
      audioContextRef.current.close().catch(console.error);

      audioContextRef.current = null;
    }

    lastLevelRef.current = 0;

    setMicEnabled(false);

    setLevel(0);
  }, []);

  // ============================================
  // FINISH SPEAKING
  // ============================================

  const finishSpeaking = useCallback(() => {
    busyRef.current = false;

    ignoreUntilRef.current =
      Date.now() + ECHO_COOLDOWN_MS;

    if (mountedRef.current) {
      setMode(
        listeningRef.current ? "listening" : "idle"
      );
    }
  }, []);

  // ============================================
  // TEXT TO SPEECH
  // ============================================

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
          /en/i.test(voice.lang) &&
          /Microsoft|Google/i.test(voice.name)
      );

      if (preferredVoice) {
        utterance.voice = preferredVoice;
      }

      utteranceRef.current = utterance;

      utterance.onstart = () => {
        if (
          utteranceRef.current === utterance &&
          mountedRef.current
        ) {
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

  // ============================================
  // STOP LISTENING
  // ============================================

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
          // Already stopped
        }
      }

      abortRef.current?.abort();

      abortRef.current = null;

      if (pendingMessageIdRef.current !== null) {
        removeHistory(pendingMessageIdRef.current);

        pendingMessageIdRef.current = null;
      }

      utteranceRef.current = null;

      window.speechSynthesis?.cancel();

      busyRef.current = false;

      stopAudioVisualizer();

      setInterim("");

      setMode(isError ? "error" : "idle");

      if (message) {
        addHistory("jarvis", message);
      }
    },
    [stopAudioVisualizer, removeHistory, addHistory]
  );

  // ============================================
  // PROCESS USER COMMAND
  // ============================================

  const processCommand = useCallback(
    async (text) => {
      const input = text.trim();

      if (!input || !mountedRef.current) return;

      // Cancel previous request
      abortRef.current?.abort();

      // Remove previous pending message
      if (pendingMessageIdRef.current !== null) {
        removeHistory(pendingMessageIdRef.current);

        pendingMessageIdRef.current = null;
      }

      const controller = new AbortController();

      abortRef.current = controller;

      // Stop previous speech
      utteranceRef.current = null;

      window.speechSynthesis?.cancel();

      busyRef.current = true;

      // USER MESSAGE - RIGHT SIDE
      addHistory("you", input);

      // THINKING MESSAGE - LEFT SIDE
      const thinkingId = addHistory(
        "jarvis",
        "Thinking...",
        "thinking"
      );

      pendingMessageIdRef.current = thinkingId;

      setInterim("");

      setMode("thinking");

      let response = null;

      try {
        // STEP 1: LOCAL COMMANDS
        response = await getLocalReply(
          input,
          controller.signal
        );

        if (
          controller.signal.aborted ||
          !mountedRef.current
        ) {
          return;
        }

        // STEP 2: AI BACKEND
        if (!response) {
          response = await sendMessage(
            input,
            controller.signal
          );

          if (mountedRef.current) {
            setBackendStatus("online");
          }
        }

        if (!response) {
          response =
            "I couldn't generate a response. Please try again.";
        }

      } catch (error) {
        if (
          controller.signal.aborted ||
          error.code === "ERR_CANCELED"
        ) {
          return;
        }

        console.error("Backend error:", error);

        if (mountedRef.current) {
          setBackendStatus("offline");
        }

        response =
          error.userMessage ||
          "Something went wrong while contacting my AI core.";
      }

      // CHECK ACTIVE REQUEST
      if (
        controller.signal.aborted ||
        !mountedRef.current ||
        abortRef.current !== controller
      ) {
        return;
      }

      // REPLACE THINKING WITH ACTUAL RESPONSE
      updateHistory(thinkingId, {
        text: response,
        status: "complete",
      });

      pendingMessageIdRef.current = null;

      busyRef.current = false;

      setMode(
        listeningRef.current ? "listening" : "idle"
      );

    },
    [addHistory, updateHistory, removeHistory]
  );

  // ============================================
  // START VOICE RECOGNITION
  // ============================================

  const startListening = useCallback(async () => {
    if (
      listeningRef.current ||
      startingRef.current
    ) {
      return;
    }

    if (!SpeechRecognition) {
      addHistory(
        "jarvis",
        "Speech recognition is unavailable. Use Chrome or Edge."
      );

      setMode("error");

      return;
    }

    startingRef.current = true;

    try {
      const micReady = await startAudioVisualizer();

      if (!micReady || !mountedRef.current) {
        stopAudioVisualizer();

        startingRef.current = false;

        return;
      }

      const recognition = new SpeechRecognition();

      recognition.lang = "en-IN";

      recognition.continuous = true;

      recognition.interimResults = true;

      recognition.onresult = (event) => {
        if (
          busyRef.current ||
          Date.now() < ignoreUntilRef.current
        ) {
          setInterim("");

          return;
        }

        let finalText = "";

        let interimText = "";

        for (
          let i = event.resultIndex;
          i < event.results.length;
          i++
        ) {
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
        if (
          event.error === "no-speech" ||
          event.error === "aborted"
        ) {
          return;
        }

        console.warn(
          "Speech recognition:",
          event.error
        );

        const message =
          FATAL_RECOGNITION_ERRORS[event.error];

        if (message) {
          stopListening(message, true);
        }
      };

      recognition.onend = () => {
        if (
          !listeningRef.current ||
          !mountedRef.current
        ) {
          return;
        }

        restartTimerRef.current = setTimeout(() => {
          if (
            !listeningRef.current ||
            recognitionRef.current !== recognition
          ) {
            return;
          }

          try {
            recognition.start();
          } catch {
            // Already running
          }
        }, 250);
      };

      recognitionRef.current = recognition;

      listeningRef.current = true;

      recognition.start();

      setMode("listening");

    } catch (error) {
      console.error(error);

      stopListening(
        "Unable to start speech recognition.",
        true
      );

    } finally {
      startingRef.current = false;
    }
  }, [
    startAudioVisualizer,
    stopAudioVisualizer,
    processCommand,
    stopListening,
    addHistory,
  ]);

  // ============================================
  // TEXT INPUT
  // ============================================

  const submitText = (event) => {
    event.preventDefault();

    const text = command.trim();

    if (!text) return;

    setCommand("");

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }

    processCommand(text);
  };

  // ============================================
  // AUTO RESIZE TEXTAREA
  // ============================================

  const handleCommandChange = (event) => {
    setCommand(event.target.value);

    const textarea = event.target;

    textarea.style.height = "auto";

    textarea.style.height =
      `${Math.min(textarea.scrollHeight, 160)}px`;
  };

  // ============================================
  // ENTER / SHIFT + ENTER
  // ============================================

  const handleInputKeyDown = (event) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();

      event.currentTarget.form?.requestSubmit();
    }
  };

  // ============================================
  // LOAD VOICES
  // ============================================

  useEffect(() => {
    const synth = window.speechSynthesis;

    if (!synth) return;

    const loadVoices = () => {
      voicesRef.current = synth.getVoices();
    };

    loadVoices();

    synth.addEventListener(
      "voiceschanged",
      loadVoices
    );

    return () => {
      synth.removeEventListener(
        "voiceschanged",
        loadVoices
      );
    };
  }, []);

  // ============================================
  // BACKEND HEALTH CHECK
  // ============================================

  useEffect(() => {
    mountedRef.current = true;

    let cancelled = false;

    const run = async () => {
      const online = await checkHealth();

      if (!cancelled && mountedRef.current) {
        setBackendStatus(
          online ? "online" : "offline"
        );
      }
    };

    run();

    const timer = setInterval(
      run,
      HEALTH_INTERVAL_MS
    );

    return () => {
      cancelled = true;

      clearInterval(timer);
    };
  }, []);

  // ============================================
  // CLEANUP
  // ============================================

  useEffect(() => {
    return () => {
      mountedRef.current = false;

      listeningRef.current = false;

      startingRef.current = false;

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
          // Already stopped
        }

        recognitionRef.current = null;
      }

      utteranceRef.current = null;

      window.speechSynthesis?.cancel();

      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }

      streamRef.current
        ?.getTracks()
        .forEach((track) => track.stop());

      streamRef.current = null;

      audioContextRef.current?.close().catch(() => {});

      audioContextRef.current = null;
    };
  }, []);

  // ============================================
  // BACKEND STATUS
  // ============================================

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

  // ============================================
  // UI
  // ============================================

  return (
    <main className="jarvis-app">

      {/* HEADER */}

      <header className="topbar">

        <div className="brand">

          <span className="brand-icon">
            J
          </span>

          <div>

            <h1>J.A.R.V.I.S.</h1>

            <span className="brand-subtitle">
              PERSONAL INTELLIGENCE SYSTEM
            </span>

          </div>

        </div>

        <div className="system-status">

          <span className={`status-dot ${mode}`} />

          {STATUS_LABEL[mode] ?? STATUS_LABEL.idle}

        </div>

      </header>

      {/* MAIN DASHBOARD */}

      <section className="main-stage">

        {/* LEFT PANEL */}

        <div className="side-panel left-panel">

          <div className="panel-label">
            VOICE INTERFACE
          </div>

          <div className="metric">

            <span>INPUT LEVEL</span>

            <strong>
              {Math.round(level * 100)}%
            </strong>

            <div className="level-track">

              <div
                className="level-fill"
                style={{
                  width: `${level * 100}%`,
                }}
              />

            </div>

          </div>

          <div className="metric">

            <span>MICROPHONE</span>

            <strong>
              {micEnabled ? "ACTIVE" : "STANDBY"}
            </strong>

          </div>

          <div
            className="equalizer"
            aria-hidden="true"
          >

            {Array.from({ length: 20 }, (_, i) => (
              <span
                key={i}
                style={{
                  height: `${
                    5 + level * (10 + ((i * 7) % 24))
                  }px`,
                }}
              />
            ))}

          </div>

        </div>

        {/* CENTER ORB */}

        <div
          className={`orb-scene mode-${mode}`}
          style={{
            "--voice-level": level,
          }}
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

            <span>
              {CAPTION_LABEL[mode] ?? CAPTION_LABEL.idle}
            </span>

            <span className="caption-line" />

          </div>

        </div>

        {/* RIGHT PANEL */}

        <div className="side-panel right-panel">

          <div className="panel-label">
            SYSTEM DIAGNOSTICS
          </div>

          <div className="diagnostic-row">

            <span>CORE</span>

            <span className="healthy">
              ● ONLINE
            </span>

          </div>

          <div className="diagnostic-row">

            <span>VOICE ENGINE</span>

            <span className={micEnabled ? "healthy" : "muted"}>
              ● {micEnabled ? "ACTIVE" : "READY"}
            </span>

          </div>

          <div className="diagnostic-row">

            <span>AI CONNECTION</span>

            <span className={backendClass}>
              {backendLabel}
            </span>

          </div>

        </div>

      </section>

      {/* COMMUNICATION LOG */}

      <section className="conversation">

        <div className="conversation-heading">

          <span>COMMUNICATION LOG</span>

          <span>
            {history.length.toString().padStart(2, "0")} ENTRIES
          </span>

        </div>

        <div
          className="conversation-log"
          ref={conversationLogRef}
          aria-live="polite"
          aria-relevant="additions text"
        >

          {history.length === 0 && !interim ? (

            <p className="empty-log">
              No conversations yet. Activate the microphone
              to begin.
            </p>

          ) : (

            <>

              {history.map((entry) => (

                <div
                  className={`log-entry ${entry.role}`}
                  key={entry.id}
                >

                  <span className="message-role">

                    {entry.role === "you"
                      ? "YOU"
                      : "JARVIS"}

                  </span>

                  <div className="message-content">

                    {entry.status === "thinking" ? (

                      <div className="thinking-indicator">

                        <span>Thinking</span>

                        <span className="thinking-dots">

                          <span>.</span>

                          <span>.</span>

                          <span>.</span>

                        </span>

                      </div>

                    ) : (

                      <div className="chat-markdown">

                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                        >
                          {entry.text}
                        </ReactMarkdown>

                      </div>

                    )}

                    {entry.role === "jarvis" &&
                      entry.status === "complete" && (

                        <button
                          type="button"
                          className="message-voice-button"
                          title="Listen to this message"
                          aria-label="Listen to JARVIS response"

                          onClick={() => {
                            const cleanText =
                              cleanTextForSpeech(entry.text);

                            speak(cleanText);
                          }}
                        >
                          🔊
                        </button>

                      )}

                  </div>

                </div>

              ))}

              {/* LIVE SPEECH INPUT */}

              {interim && (

                <div className="log-entry you interim">

                  <span className="message-role">
                    YOU
                  </span>

                  <div className="message-content">

                    <p>{interim}</p>

                  </div>

                </div>

              )}

            </>

          )}

        </div>

        {/* CHAT INPUT */}

        <form
          className="command-form"
          onSubmit={submitText}
        >

          <span className="input-prefix">
            &gt;
          </span>

          <textarea
            ref={textareaRef}
            value={command}
            onChange={handleCommandChange}
            onKeyDown={handleInputKeyDown}
            placeholder="Message JARVIS..."
            aria-label="Message JARVIS"
            autoComplete="off"
            rows={1}
          />

          <button
            type="submit"
            className="send-button"
            disabled={!command.trim()}
          >
            SEND ↗
          </button>

        </form>

      </section>

      {/* FOOTER */}

      <footer className="control-bar">

        <div className="footer-status">

          <span className="status-dot" />

          JARVIS LOCAL INTERFACE

        </div>

        <button
          className={`mic-button ${
            micEnabled ? "active" : ""
          }`}
          onClick={() => {
            if (micEnabled) {
              stopListening();
            } else {
              startListening();
            }
          }}
          type="button"
        >

          <span>
            {micEnabled ? "■" : "🎙"}
          </span>

          {micEnabled
            ? "DISCONNECT VOICE"
            : "ACTIVATE VOICE"}

        </button>

        <div className="footer-version">
          INTERFACE V1.4
        </div>

      </footer>

    </main>
  );
}