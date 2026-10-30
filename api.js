// Talks to the Python backend. Keep ALL network code here so App.jsx stays clean.
//
// In development, vite.config.js proxies /api -> http://localhost:8000
// In production, set VITE_API_URL (e.g. https://jarvis.example.com/api)

const API_BASE = (import.meta.env.VITE_API_URL ?? "/api").replace(/\/$/, "");
const CHAT_TIMEOUT_MS = 30000;
const HEALTH_TIMEOUT_MS = 4000;

// One id per page load so the backend can keep conversation memory per user.
const sessionId =
  globalThis.crypto?.randomUUID?.() ??
  `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;

export class ApiError extends Error {
  constructor(userMessage, options) {
    super(userMessage, options);
    this.name = "ApiError";
    // Safe, friendly text that JARVIS can speak aloud.
    this.userMessage = userMessage;
  }
}

async function requestJson(path, { method = "GET", body, signal, timeoutMs }) {
  const controller = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // Let the caller cancel too (e.g. a newer command replaces this one).
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ApiError("My AI core returned an error. Please try again.");
    }

    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;

    if (timedOut) {
      throw new ApiError(
        "The AI core took too long to respond. Please try again.",
        { cause: error }
      );
    }

    // Cancelled by the caller: rethrow the original AbortError.
    if (signal?.aborted) throw error;

    throw new ApiError(
      "I can't reach my AI core. Please check that the backend server is running.",
      { cause: error }
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function sendMessage(message, signal) {
  const data = await requestJson("/chat", {
    method: "POST",
    body: { message, session_id: sessionId },
    signal,
    timeoutMs: CHAT_TIMEOUT_MS,
  });

  const reply = typeof data?.reply === "string" ? data.reply.trim() : "";

  if (!reply) {
    throw new ApiError("My AI core sent an empty reply.");
  }

  return reply;
}

export async function checkHealth() {
  try {
    await requestJson("/health", { timeoutMs: HEALTH_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}
