import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const noop = () => {};
const DISABLED = Object.freeze({
  now: () => 0, mark: noop, runnerBoot: noop, beginTurn: noop, firstProviderDelta: noop, firstPersistedText: noop,
});

/** Diagnostics contain only bounded stage names, durations, and opaque IDs. */
export function createCodexSendTiming(sessionId, write = (line) => process.stderr.write(line), enabled = false) {
  if (!enabled) return DISABLED;
  const session = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  let turnIndex = 0;
  let turnStartedAt = 0;
  let providerDeltaSeen = false;
  let persistedTextSeen = false;
  const emit = (stage, durationMs, index) => {
    write(`${JSON.stringify({ event: "codex_send_timing", session, turnIndex: index,
      stage, durationMs: Math.max(0, Math.round(durationMs)) })}\n`);
  };
  const mark = (stage, startedAt, index = turnIndex) => emit(stage, performance.now() - startedAt, index);
  return {
    now: () => performance.now(),
    mark,
    // Time from runner process start (the perf_hooks time origin) to first use.
    runnerBoot() { emit("runner_boot", performance.now(), 0); },
    beginTurn(index) {
      turnIndex = index;
      turnStartedAt = performance.now();
      providerDeltaSeen = false;
      persistedTextSeen = false;
    },
    firstProviderDelta() {
      if (!turnStartedAt || providerDeltaSeen) return;
      providerDeltaSeen = true;
      mark("first_provider_delta", turnStartedAt);
    },
    firstPersistedText() {
      if (!turnStartedAt || persistedTextSeen) return;
      persistedTextSeen = true;
      mark("first_persisted_text", turnStartedAt);
    },
  };
}
