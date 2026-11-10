import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type CodexCatalogTimingResult = "cache_hit" | "stale_hit" | "lookup" | "lookup_shared" | "failed";

const LOG_PREFIX = "[chat-send-timing]";
const activeSend = new AsyncLocalStorage<string>();

// Diagnostics carry only opaque IDs, fixed stage names, and durations. Never
// add prompts, replies, credentials, account names, paths, or provider bodies.
function emit(record: Record<string, string | number>): void {
  console.info(LOG_PREFIX, JSON.stringify(record));
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

export function chatSendTimingsEnabled(): boolean {
  return process.env.MATRIX_CODEX_SEND_TIMINGS === "1";
}

export type ChatSendTimer = ReturnType<typeof createChatSendTimer>;

export function createChatSendTimer(clientRequestId: string) {
  const traceId = createHash("sha256").update(clientRequestId).digest("hex").slice(0, 20);
  return {
    run<T>(callback: () => T): T { return activeSend.run(traceId, callback); },
    mark(stage: string, startedAt: number): void { emit({ traceId, stage, durationMs: elapsed(startedAt) }); },
    linkRun(runId: string, driver: string): void { emit({ traceId, stage: "run_link", runId, driver }); },
  };
}

export function createChatDispatchTimer(runId: string, driver: string) {
  const startedAt = performance.now();
  let eventSeen = false;
  let textSeen = false;
  return {
    adapterStart(): void {
      emit({ runId, driver, stage: "dispatch_prepare", durationMs: elapsed(startedAt) });
    },
    providerEvent(): void {
      if (eventSeen) return;
      eventSeen = true;
      emit({ runId, driver, stage: "first_provider_event", durationMs: elapsed(startedAt) });
    },
    displayableText(): void {
      if (textSeen) return;
      textSeen = true;
      emit({ runId, driver, stage: "first_displayable_text", durationMs: elapsed(startedAt) });
    },
  };
}

export function recordCodexCatalogTiming(result: CodexCatalogTimingResult, durationMs: number): void {
  const traceId = activeSend.getStore();
  if (traceId) emit({ traceId, stage: "codex_catalog", durationMs: Math.max(0, Math.round(durationMs)), result });
}
