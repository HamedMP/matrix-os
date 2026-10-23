import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

/** Diagnostics contain only bounded stage names, durations, and opaque IDs. */
export function createCodexSendTiming(sessionId, write = (line) => process.stderr.write(line), enabled = true) {
  const session = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  let turnIndex = 0;
  let turnStartedAt = 0;
  let providerDeltaSeen = false;
  let persistedTextSeen = false;
  const mark = (stage, startedAt, index = turnIndex) => {
    if (!enabled) return;
    write(`${JSON.stringify({ event: "codex_send_timing", session, turnIndex: index,
      stage, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) })}\n`);
  };
  return {
    now: () => performance.now(),
    mark,
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
