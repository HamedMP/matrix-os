import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

export type CodexCatalogTimingResult = "cache_hit" | "stale_hit" | "lookup" | "lookup_shared" | "failed";

const LOG_PREFIX = "[chat-send-timing]";
type ActiveTiming = { traceId: string } | { runId: string; driver: string };
const activeSend = new AsyncLocalStorage<ActiveTiming>();

/**
 * Fixed sub-stage names. Callers deep in the send path (catalog, identity,
 * launch) record against whichever timed send or dispatch is active. Outside
 * one, or with the flag off, nothing is emitted and no timer is created.
 */
export type ChatSendSubStage =
  | "catalog_coding_inventory" | "catalog_settings_snapshot"
  | "codex_identity_observe" | "codex_identity_verify" | "claude_identity"
  | "codex_execution_admission"
  | "codex_admission_start" | "codex_events_watch" | "codex_admission_validate"
  | "session_start" | "browser_prepare" | "turn_submit" | "thread_store_queue_wait"
  | "native_launch_admission" | "background_lock_wait" | "launch_build" | "launch_request"
  | "background_queue_wait" | "background_flock" | "background_inventory"
  | "systemd_run_spawned" | "unit_active" | "provider_event_file_first_line";

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

/** Join a Chat run to native runner logs without exposing thread or turn IDs. */
export function recordCodexRunnerLink(runId: string, threadId: string, turnId?: string): void {
  if (!chatSendTimingsEnabled() || !threadId.startsWith("thread_")
    || (turnId !== undefined && !turnId.startsWith("turn_"))) return;
  const sessionId = `sess_${threadId.slice("thread_".length)}`;
  const session = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
  emit({ runId, stage: "runner_link", session,
    ...(turnId === undefined
      ? { turnIndex: 1 }
      : { turnKey: createHash("sha256").update(`req_${turnId.slice("turn_".length)}`).digest("hex").slice(0, 20) }),
  });
}

export type ChatSendTimer = ReturnType<typeof createChatSendTimer>;

export function createChatSendTimer(clientRequestId: string) {
  const traceId = createHash("sha256").update(clientRequestId).digest("hex").slice(0, 20);
  return {
    run<T>(callback: () => T): T { return activeSend.run({ traceId }, callback); },
    mark(stage: string, startedAt: number): void { emit({ traceId, stage, durationMs: elapsed(startedAt) }); },
    linkRun(runId: string, driver: string): void { emit({ traceId, stage: "run_link", runId, driver }); },
  };
}

export function createChatDispatchTimer(runId: string, driver: string) {
  const startedAt = performance.now();
  let eventSeen = false;
  let textSeen = false;
  return {
    run<T>(callback: () => T): T { return activeSend.run({ runId, driver }, callback); },
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
  const active = activeSend.getStore();
  if (active && "traceId" in active) emit({ traceId: active.traceId, stage: "codex_catalog", durationMs: Math.max(0, Math.round(durationMs)), result });
}

/** Start a sub-stage only inside a timed send or dispatch; returns undefined otherwise. */
export function startChatSendStage(): number | undefined {
  return chatSendTimingsEnabled() && activeSend.getStore() ? performance.now() : undefined;
}

/** Emit a fixed sub-stage for the active send or dispatch. No-op when startedAt is undefined. */
export function recordChatSendStage(stage: ChatSendSubStage, startedAt: number | undefined): void {
  if (startedAt === undefined) return;
  const active = activeSend.getStore();
  if (!active || !chatSendTimingsEnabled()) return;
  emit({ ...active, stage, durationMs: elapsed(startedAt) });
}

/** Time one awaited operation as a sub-stage; the operation runs unchanged when untimed. */
export async function timeChatSendStage<T>(stage: ChatSendSubStage, operation: () => Promise<T>): Promise<T> {
  const startedAt = startChatSendStage();
  try { return await operation(); } finally { recordChatSendStage(stage, startedAt); }
}

/** Capture the active timing context so a later callback (e.g. a poll) can record against it. */
export function captureChatSendStage(): ((stage: ChatSendSubStage, startedAt: number) => void) | undefined {
  const active = chatSendTimingsEnabled() ? activeSend.getStore() : undefined;
  if (!active) return undefined;
  return (stage, startedAt) => emit({ ...active, stage, durationMs: elapsed(startedAt) });
}

/** Run a callback (e.g. one that creates a long-lived watcher) outside any timed send or dispatch. */
export function outsideChatSendTiming<T>(callback: () => T): T {
  return activeSend.exit(callback);
}
