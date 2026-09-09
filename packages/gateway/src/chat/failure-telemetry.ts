import { CanonicalChatContentSchema, CanonicalChatSafeErrorSchema, type CanonicalChatContent } from "@matrix-os/contracts";
import { z } from "zod/v4";
import { MATRIX_TELEMETRY_EVENTS } from "@matrix-os/observability/events";
import type { AiCaptureFn } from "../ai-analytics.js";
import type { ChatOutboxSink } from "./outbox-delivery.js";
import { ChatRunFailureDiagnosticSchema, CHAT_FAILURE_CATEGORY_REASONS, CHAT_RUN_CLEANUP_UNCONFIRMED_MESSAGE } from "./failure-diagnostic.js";

const ERROR_REASONS: Record<string, string> = {
  provider_unavailable: "Agent provider unavailable",
  provider_instance_locked: "Agent provider is busy",
  model_unavailable: "Selected model unavailable",
  capability_mismatch: "Required capability unavailable",
  authorization_failed: "Authorization failed",
  service_unavailable: "Required service unavailable",
  resource_unavailable: "Required resource unavailable",
  run_not_resumable: "Agent run cannot be resumed",
  run_unavailable: "Agent run state unavailable",
  run_failed: "Agent execution failed; detailed reason unavailable",
};
const ProviderSchema = z.enum(["codex", "claude_code", "kernel", "pi", "opencode", "openclaw", "hermes", "other"]);
const FailureMetadataSchema = z.object({
  provider: ProviderSchema,
  errorCode: CanonicalChatSafeErrorSchema.shape.code,
  durationMs: z.number().finite().nonnegative().optional(),
  diagnostic: ChatRunFailureDiagnosticSchema.optional(),
  kind: z.enum(["execution", "projection", "synchronization"]),
  runStatus: z.enum(["accepted", "running", "waiting_for_approval", "waiting_for_input", "completed", "failed", "aborted", "unknown"]),
}).strict();

// Persist this small allowlisted summary even when the content frame is too large.
// The caller already holds the mutation's transaction and Chat lock.
export function captureChatFailureMetadata(eventType: string, content: CanonicalChatContent | undefined, runId: unknown, diagnostic?: unknown) {
  if (eventType !== "run.failed" && eventType !== "run.activity") return undefined;
  const run = content?.runs?.find((entry) => entry.id === runId);
  const failure = content?.activities?.find((entry) => entry.type === "run.error" && entry.runId === runId);
  const unconfirmed = eventType === "run.activity" && failure?.type === "run.error"
    && failure.error.code === "run_unavailable" && failure.error.safeMessage === CHAT_RUN_CLEANUP_UNCONFIRMED_MESSAGE;
  if (eventType === "run.activity" && !unconfirmed) return undefined;
  const detail = unconfirmed ? { stage: "cleanup" as const, category: "unknown" as const }
    : ChatRunFailureDiagnosticSchema.safeParse(diagnostic).data;
  return FailureMetadataSchema.parse({
    provider: ProviderSchema.safeParse(run?.driverKind).data ?? "other",
    errorCode: failure?.type === "run.error" ? failure.error.code : "run_failed",
    durationMs: run?.startedAt && (run.completedAt ?? failure?.occurredAt)
      ? Math.max(0, Date.parse((run.completedAt ?? failure!.occurredAt)) - Date.parse(run.startedAt)) : undefined,
    diagnostic: detail,
    kind: unconfirmed || detail?.stage === "persistence" || detail?.stage === "recovery" ? "synchronization" : detail?.stage === "projection" ? "projection" : "execution",
    runStatus: run?.status ?? "unknown",
  });
}

/** Only canonical IDs and bounded diagnostic categories leave the owner's runtime. */
export function createChatFailureRecorder(options: {
  capture: AiCaptureFn;
  runtimeVersion?: string;
  buildSha?: string;
  logger?: { warn(message: string): void };
}): ChatOutboxSink {
  return ({ owner, event }) => {
    if (event.eventType !== "run.failed" && event.eventType !== "run.activity") return;
    const runId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;
    let metadata = FailureMetadataSchema.safeParse(event.payload.failureTelemetry).data;
    if (!metadata && event.eventType === "run.failed") {
      const parsed = CanonicalChatContentSchema.safeParse(event.payload.streamContent);
      metadata = captureChatFailureMetadata(event.eventType, parsed.success ? parsed.data : undefined, runId);
    }
    if (!metadata) return;
    const code = metadata.errorCode;
    try {
      const result = options.capture(event.eventType === "run.failed"
        ? MATRIX_TELEMETRY_EVENTS.AGENT_RUN_FAILED : MATRIX_TELEMETRY_EVENTS.AGENT_RUN_SYNC_FAILED, {
        distinctId: owner.ownerId,
        properties: {
          chat_id: event.chatId,
          run_id: runId,
          failure_kind: metadata.kind,
          failure_stage: metadata.diagnostic?.stage ?? "execution",
          run_status: metadata.runStatus,
          provider: metadata.provider,
          error_code: code,
          error_category: metadata.diagnostic?.category ?? "unknown",
          error_reason: event.eventType === "run.activity" ? "Backing execution cleanup not confirmed"
            : metadata.diagnostic && metadata.diagnostic.category !== "unknown"
              ? CHAT_FAILURE_CATEGORY_REASONS[metadata.diagnostic.category]
              : ERROR_REASONS[code] ?? CHAT_FAILURE_CATEGORY_REASONS.unknown,
          runtime_version: options.runtimeVersion && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(options.runtimeVersion)
            ? options.runtimeVersion : undefined,
          build_sha: options.buildSha && /^[a-f0-9]{7,40}$/i.test(options.buildSha) ? options.buildSha : undefined,
          duration_ms: metadata.durationMs,
        },
      });
      void Promise.resolve(result).catch((error: unknown) => {
        (options.logger ?? console).warn(`[chat/telemetry] Failure event delivery rejected: ${error instanceof Error ? "Error" : "UnknownError"}`);
      });
    } catch (error: unknown) {
      (options.logger ?? console).warn(`[chat/telemetry] Failure event delivery failed: ${error instanceof Error ? "Error" : "UnknownError"}`);
    }
  };
}
