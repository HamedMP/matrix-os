import { AgentConfigError } from "./errors.js";
import type { AgentRuntimeSettingsSnapshot, AgentRuntimeSource } from "./service.js";
const MAX_WAITERS = 64;
const OBSERVATION_TIMEOUT_MS = 6500;
/** Share only live work; a settled observation is never reused as authority. */
export function createRuntimeObservation(read: AgentRuntimeSource) {
  let pending: {
    controller: AbortController;
    promise: Promise<AgentRuntimeSettingsSnapshot>;
    work: Promise<AgentRuntimeSettingsSnapshot>;
    waiters: number;
  } | null = null;
  let mutating = false;
  let closed = false;
  const source: AgentRuntimeSource = async (signal) => {
    signal.throwIfAborted();
    if (closed || mutating || pending?.controller.signal.aborted)
      throw new AgentConfigError("runtime_unavailable");
    if (pending === null) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(new AgentConfigError("runtime_unavailable")), OBSERVATION_TIMEOUT_MS);
      let onAbort: (() => void) | undefined;
      const work = Promise.resolve().then(() => read(controller.signal));
      const attempt = { controller, waiters: 0, work, promise: work };
      attempt.promise = Promise.race([attempt.promise, new Promise<never>((_, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", onAbort, { once: true });
      })]).finally(() => {
        clearTimeout(timeout);
        if (onAbort)
          controller.signal.removeEventListener("abort", onAbort);
      });
      pending = attempt;
      const release = () => {
        if (pending === attempt)
          pending = null;
      };
      void work.then(release, release);
    }
    const attempt = pending;
    if (attempt.waiters >= MAX_WAITERS)
      throw new AgentConfigError("agent_config_conflict");
    attempt.waiters++;
    let onAbort: (() => void) | undefined;
    try {
      const snapshot = await Promise.race([attempt.promise, new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted)
          onAbort();
      })]);
      signal.throwIfAborted();
      if (closed || mutating || attempt.controller.signal.aborted)
        throw new AgentConfigError("runtime_unavailable");
      // Readers may project/renew metadata independently; do not share mutable data.
      return structuredClone(snapshot);
    }
    finally {
      if (onAbort)
        signal.removeEventListener("abort", onAbort);
      attempt.waiters--;
      if (attempt.waiters === 0 && pending === attempt)
        attempt.controller.abort();
    }
  };
  const abortPending = async () => {
    const attempt = pending;
    if (!attempt)
      return;
    attempt.controller.abort(new AgentConfigError("runtime_unavailable"));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([attempt.work, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new AgentConfigError("runtime_unavailable")), OBSERVATION_TIMEOUT_MS);
      })]);
    }
    catch (error: unknown) {
      const cancelled = error === attempt.controller.signal.reason
        || (error instanceof Error && error.name === "AbortError")
        || (error instanceof AgentConfigError && error.kind === "runtime_unavailable");
      // Preserve unexpected failures and refuse an undrained dependency.
      if (!cancelled || pending === attempt) throw error;
    }
    finally {
      if (timeout)
        clearTimeout(timeout);
    }
  };
  return {
    source,
    async mutate<T>(operation: () => Promise<T>): Promise<T> {
      if (closed || mutating)
        throw new AgentConfigError("agent_config_conflict");
      mutating = true;
      try {
        await abortPending();
        return await operation();
      }
      finally {
        mutating = false;
      }
    },
    async close(): Promise<void> { closed = true; await abortPending(); },
  };
}
