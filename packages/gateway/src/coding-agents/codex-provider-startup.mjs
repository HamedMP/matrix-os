import { spawn } from "node:child_process";
import { RetryableProviderStartupTimeout, retryUnadmittedStartup } from "./provider-startup-retry.mjs";

const MAX_HANDSHAKE_BYTES = 1024 * 1024;
const INITIALIZE_ID = "matrix_startup_initialize";
class InitializationTimeout extends Error {}
export class ProviderStartupCleanupUnconfirmed extends Error {
  constructor(child, closed) {
    super("Provider startup cleanup unconfirmed");
    this.name = "ProviderStartupCleanupUnconfirmed";
    this.child = child;
    this.closed = closed;
  }
}

function startupTimeout(env) {
  const value = Number(env.MATRIX_CODEX_STARTUP_TIMEOUT_MS ?? 30_000);
  if (!Number.isSafeInteger(value) || value < 1 || value > 30_000) throw new Error("Invalid startup timeout");
  return value;
}

export function signalCodexProviderChild(child, signal) {
  try { child.kill(signal); }
  catch (error) {
    // A failed signal does not prove the process stopped. Keep its close
    // listener and the caller's cleanup ownership intact.
    console.warn("[coding-agents] Provider termination signal failed:", error instanceof Error ? error.name : "UnknownError");
  }
}

async function confirmedStop(child, closed) {
  signalCodexProviderChild(child, "SIGTERM");
  let forceTimer;
  let deadline;
  try {
    forceTimer = setTimeout(() => signalCodexProviderChild(child, "SIGKILL"), 1_000);
    // A signal or a timeout is not exit evidence. Only the child's close event
    // can make this attempt eligible for another process.
    await Promise.race([closed, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new ProviderStartupCleanupUnconfirmed(child, closed)), 5_000);
    })]);
  } finally {
    clearTimeout(forceTimer);
    clearTimeout(deadline);
  }
}

async function initializeAttempt({ command, args, cwd, env, signal }) {
  signal.throwIfAborted();
  const child = spawn(command, [...args, "app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", (code, exitSignal) => resolve({ code, signal: exitSignal })));
  // Suppress raw stderr during initialization; the owner takes over after ready.
  const discard = () => undefined;
  child.stderr.on("data", discard);
  // Keep late pipe errors contained while cancellation drains the exact child.
  child.stdin.on("error", discard);
  child.on("error", discard);
  let cleanup;
  try {
    await new Promise((resolve, reject) => {
      let buffered = Buffer.alloc(0);
      let seenBytes = 0;
      const timeout = setTimeout(() => reject(new InitializationTimeout()), startupTimeout(env));
      const abort = () => reject(signal.reason);
      const failed = () => reject(new Error("Provider initialization unavailable"));
      const data = (chunk) => {
        seenBytes += chunk.byteLength;
        if (seenBytes > MAX_HANDSHAKE_BYTES) { reject(new Error("Provider initialization response too large")); return; }
        buffered = Buffer.concat([buffered, chunk]);
        let newline;
        while ((newline = buffered.indexOf(10)) >= 0) {
          const line = buffered.subarray(0, newline).toString("utf8");
          buffered = buffered.subarray(newline + 1);
          let message;
          try { message = JSON.parse(line); }
          catch (error) { if (error instanceof SyntaxError) { reject(new Error("Invalid initialization response")); return; } throw error; }
          if (message?.id !== INITIALIZE_ID || message.method !== undefined) continue;
          if (message.error !== undefined || !Object.hasOwn(message, "result")) {
            reject(new Error("Provider initialization rejected")); return;
          }
          child.stdout.pause();
          child.stdout.off("data", data);
          if (buffered.length > 0) child.stdout.unshift(buffered);
          resolve();
          return;
        }
      };
      cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        child.off("error", failed);
        child.off("close", failed);
        child.stdin.off("error", failed);
        child.stdout.off("data", data);
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", failed);
      child.once("close", failed);
      child.stdin.once("error", failed);
      child.stdout.on("data", data);
      child.stdin.write(`${JSON.stringify({ id: INITIALIZE_ID, method: "initialize", params: {
        clientInfo: { name: "matrix-os", title: "Matrix OS", version: "1" },
        capabilities: { experimentalApi: true },
      } })}\n`);
    });
    signal.throwIfAborted();
    child.stderr.pause();
    return { child, closed };
  } catch (error) {
    // No thread/start, thread/resume or turn/start has been sent by this helper.
    cleanup?.();
    await confirmedStop(child, closed);
    signal.throwIfAborted();
    if (error instanceof InitializationTimeout) throw new RetryableProviderStartupTimeout();
    throw error;
  } finally {
    cleanup?.();
    child.stderr.off("data", discard);
  }
}

export function initializeCodexProvider({ signal, onRetry, ...options }) {
  return retryUnadmittedStartup({ signal, onRetry,
    attempt: (attemptSignal) => initializeAttempt({ ...options, signal: attemptSignal }),
  });
}
