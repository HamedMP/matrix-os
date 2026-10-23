import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

type CatalogResult = "cache_hit" | "stale_hit" | "lookup" | "lookup_shared" | "refresh";
const activeSend = new AsyncLocalStorage<string>();

function emit(traceId: string, stage: string, durationMs: number, result?: string): void {
  // Trace IDs are hashes of request IDs. Never record prompts, credentials,
  // account names, paths, or provider response bodies in latency diagnostics.
  console.info("[chat-send-timing]", JSON.stringify({
    traceId, stage, durationMs: Math.max(0, Math.round(durationMs)),
    ...(result ? { result } : {}),
  }));
}

export function createChatSendTimer(clientRequestId: string) {
  const traceId = createHash("sha256").update(clientRequestId).digest("hex").slice(0, 20);
  return {
    traceId,
    run<T>(callback: () => T): T { return activeSend.run(traceId, callback); },
    mark(stage: string, start: number, result?: string): void {
      emit(traceId, stage, performance.now() - start, result);
    },
    linkRun(runId: string): void {
      console.info("[chat-send-timing]", JSON.stringify({ traceId, stage: "run_link", runId }));
    },
  };
}

export function recordCodexCatalogTiming(result: CatalogResult, durationMs: number): void {
  const traceId = activeSend.getStore();
  if (traceId) emit(traceId, "codex_catalog", durationMs, result);
}
