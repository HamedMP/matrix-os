/**
 * Canonical Chat bindings for the voice session engine.
 *
 * This module is the single composition point where the engine's narrow
 * ports are satisfied by canonical authorities: finalized speech enters
 * through `admitCanonicalTurn`/`enqueueCanonicalQueuedTurn`, delivery state
 * lands in `chat_voice_deliveries`, canonical Chat events arrive through the
 * outbox sink, and run control goes through the orchestrator. Nothing here
 * grants the voice path its own transcript, memory, or action authority.
 */
import type {
  CanonicalChatContent,
  CanonicalChatRunActivity,
  CanonicalCreateChatTurnRequest,
  CanonicalChatRunPolicy,
} from "@matrix-os/contracts";
import { CanonicalChatContentSchema } from "@matrix-os/contracts";
import type {
  SafeVoiceErrorCode,
  VoiceRecoveryAction,
} from "@matrix-os/contracts/voice-session";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { CanonicalChatOrchestrationError } from "../chat/orchestration-errors.js";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatOutboxEvent, ChatOwner } from "../chat/records.js";
import type { ChatVoiceDeliveryRepository } from "../chat/voice-delivery-repository.js";
import type { RequestPrincipal } from "../request-principal.js";
import type {
  VoiceAdmissionPort,
  VoiceCanonicalChatEvent,
  VoiceChatAccessPort,
  VoiceChatEventSource,
  VoiceChatEventSubscription,
  VoiceDeliveryPort,
  VoiceRunControlPort,
  VoiceTurnAdmissionRequest,
  VoiceTurnAdmissionResult,
} from "./ports.js";
import { VoiceSessionError } from "./engine.js";

const MAX_UNHEARD_HINT_IDS = 200;
const FENCED_WRITE_ATTEMPTS = 3;

function ownerFor(principalId: string): ChatOwner {
  return { type: "personal", ownerId: principalId };
}

function principalFor(request: VoiceTurnAdmissionRequest): RequestPrincipal {
  return { userId: request.principalId, source: request.principalSource };
}

function runPolicyFor(request: VoiceTurnAdmissionRequest): CanonicalChatRunPolicy {
  return {
    memoryMode: request.memoryMode,
    source: "voice",
    voiceSessionId: request.sessionId,
    nativeCheckpointPolicy: request.memoryMode === "session_only" ? "disposable" : "reusable",
  };
}

function turnInputFor(request: VoiceTurnAdmissionRequest): CanonicalCreateChatTurnRequest {
  return {
    clientRequestId: request.clientRequestId,
    baseRevision: request.baseRevision,
    parts: [{ type: "text", text: request.transcript }],
    selection: request.selection,
    interactionMode: request.interactionMode,
    permissionMode: request.permissionMode,
    ...(request.executionRoot !== undefined ? { executionRoot: request.executionRoot } : {}),
    runPolicy: runPolicyFor(request),
  };
}

function denied(code: SafeVoiceErrorCode, retryable: boolean, recovery: VoiceRecoveryAction) {
  return { outcome: "rejected" as const, revision: 0, error: { code, retryable, recovery } };
}

function failed(code: SafeVoiceErrorCode, retryable: boolean, recovery: VoiceRecoveryAction) {
  return { outcome: "failed" as const, revision: 0, error: { code, retryable, recovery } };
}

/** Map canonical admission errors onto the safe voice vocabulary. */
function mapAdmissionError(error: unknown): VoiceTurnAdmissionResult {
  if (error instanceof CanonicalChatOrchestrationError) {
    const code = error.safeError.code;
    const retryable = error.safeError.retryable === true;
    switch (code) {
      case "chat_not_found":
        return denied("chat_unavailable", false, "continue_in_chat");
      case "chat_conflict":
        return denied("session_conflict", true, "retry_connection");
      case "capability_mismatch":
        return denied("unsupported_surface", false, "continue_in_chat");
      case "authorization_failed":
        return denied("permission_denied", false, "none");
      case "provider_unavailable":
      case "model_unavailable":
        return failed("provider_unavailable", retryable, "retry_connection");
      case "provider_instance_locked":
        return denied("provider_unavailable", false, "continue_in_chat");
      case "chat_busy":
      case "chat_unavailable":
      case "run_unavailable":
      case "service_unavailable":
        return failed("chat_unavailable", true, "retry_connection");
      case "project_required":
      case "project_unavailable":
      case "resource_unavailable":
        return denied("chat_unavailable", false, "continue_in_chat");
      case "history_window_required":
      case "run_not_resumable":
      case "run_not_found":
        return denied("session_conflict", false, "start_new_session");
      default:
        return failed("internal_failure", false, "contact_support");
    }
  }
  return failed("internal_failure", false, "contact_support");
}

/**
 * Response/run/message ids whose deliveries are not verified `complete`.
 * Supplied as `unheardResponses` so a new turn's checkpoint eligibility can
 * never silently continue from assistant text the user provably did not hear.
 */
async function listUnheardDeliveryIds(
  deliveries: ChatVoiceDeliveryRepository, owner: ChatOwner, chatId: string,
): Promise<string[]> {
  const rows = await deliveries.kysely.selectFrom("chat_voice_deliveries as delivery")
    .innerJoin("chats as chat", "chat.id", "delivery.chat_id")
    .select(["delivery.run_id", "delivery.message_id"])
    .where("delivery.chat_id", "=", chatId)
    .where("chat.owner_type", "=", owner.type)
    .where("chat.owner_id", "=", owner.ownerId)
    .where("delivery.state", "<>", "complete")
    .orderBy("delivery.created_at", "desc")
    .limit(MAX_UNHEARD_HINT_IDS)
    .execute();
  return rows.flatMap((row) => [row.run_id, row.message_id]);
}

export function createCanonicalVoicePorts(options: {
  orchestrator: CanonicalChatOrchestrator;
  repository: ChatRepository;
  deliveries: ChatVoiceDeliveryRepository;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): {
  admission: VoiceAdmissionPort;
  delivery: VoiceDeliveryPort;
  chatEvents: VoiceChatEventSource;
  runControl: VoiceRunControlPort;
  chatAccess: VoiceChatAccessPort;
} {
  const log = options.log ?? (() => undefined);

  const resolveAssistantMessageId = async (
    chatId: string, runId: string,
  ): Promise<string | undefined> => {
    const row = await options.deliveries.kysely.selectFrom("chat_messages")
      .select("id")
      .where("chat_id", "=", chatId)
      .where("run_id", "=", runId)
      .where("role", "=", "assistant")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.id;
  };

  const admission: VoiceAdmissionPort = {
    async admitFinalTranscript(request) {
      const owner = ownerFor(request.principalId);
      const principal = principalFor(request);
      const input = turnInputFor(request);
      let unheardResponses: string[] = [];
      try {
        unheardResponses = await listUnheardDeliveryIds(options.deliveries, owner, request.chatId);
      } catch (error: unknown) {
        // Fail closed for resume eligibility: keep the admission alive but
        // supply every known boundary so nothing unheard seeds the next run.
        log("voice.admission.unheard_lookup_failed", {
          sessionId: request.sessionId,
          error: error instanceof Error ? error.name : "UnknownError",
        });
      }
      const hints = unheardResponses.length > 0
        ? { deliveryContext: { unheardResponses } }
        : undefined;
      try {
        const admitted = await options.orchestrator.admitTurn(
          principal, owner, request.chatId, input,
          hints ? { deliveryContext: hints.deliveryContext } : undefined,
        );
        return {
          outcome: admitted.admission === "already_accepted" ? "already_accepted" : "sent",
          canonicalTurnId: admitted.turn.id,
          runId: admitted.run.id,
          revision: Number(admitted.record.chat.revision),
        };
      } catch (error: unknown) {
        const busy = error instanceof CanonicalChatOrchestrationError
          && error.safeError.code === "chat_busy";
        if (!busy) return mapAdmissionError(error);
      }
      // Chat busy → canonical queue admission with the same immutable policy.
      try {
        const queued = await options.orchestrator.enqueueQueuedTurn(
          principal, owner, request.chatId, input,
        );
        const record = await options.repository.get(owner, request.chatId);
        return {
          outcome: "queued",
          canonicalQueuedTurnId: queued.queuedTurn.id,
          revision: Number(record?.chat.revision ?? input.baseRevision),
        };
      } catch (error: unknown) {
        return mapAdmissionError(error);
      }
    },
  };

  const delivery: VoiceDeliveryPort = {
    async recordPending(input) {
      const owner = ownerFor(input.principalId);
      const messageId = await resolveAssistantMessageId(input.chatId, input.runId);
      if (!messageId) {
        // No canonical assistant text to bind yet — the record would be a lie.
        throw new VoiceSessionError("internal_failure", "Assistant message unavailable", 500);
      }
      const result = await options.deliveries.recordPending(owner, {
        chatId: input.chatId,
        responseId: input.responseId,
        runId: input.runId,
        messageId,
        transportEpoch: input.transportEpoch,
        segments: input.segments.map((segment) => ({ ...segment })),
      });
      return { revision: result.record?.revision ?? 1 };
    },

    async recordDelivered(input) {
      const owner = ownerFor(input.principalId);
      for (let attempt = 0; attempt < FENCED_WRITE_ATTEMPTS; attempt += 1) {
        const record = await options.deliveries.get(owner, input.chatId, input.responseId);
        if (!record) return "ignored";
        const result = await options.deliveries.recordDelivered(owner, {
          chatId: input.chatId,
          responseId: input.responseId,
          deliveredThroughMs: input.deliveredThroughMs,
          revision: record.revision,
          transportEpoch: input.transportEpoch,
        });
        if (result.outcome === "delivered" || result.outcome === "duplicate") {
          return { revision: result.record?.revision ?? record.revision };
        }
        if (result.outcome !== "stale") return "ignored";
      }
      return "ignored";
    },

    async acknowledge(input) {
      const owner = ownerFor(input.principalId);
      for (let attempt = 0; attempt < FENCED_WRITE_ATTEMPTS; attempt += 1) {
        const record = await options.deliveries.get(owner, input.chatId, input.responseId);
        if (!record) return "ignored";
        const result = await options.deliveries.acknowledge(owner, {
          chatId: input.chatId,
          responseId: input.responseId,
          segmentId: input.segmentId,
          playedThroughMs: input.playedThroughMs,
          revision: record.revision,
          transportEpoch: input.transportEpoch,
        });
        if (result.outcome === "acknowledged" || result.outcome === "duplicate") {
          return { revision: result.record?.revision ?? record.revision };
        }
        if (result.outcome !== "stale") return "ignored";
      }
      return "ignored";
    },

    async recordTerminal(input) {
      const owner = ownerFor(input.principalId);
      // Crash-window backfill: when the pending write never committed, seed it
      // from the ledger snapshot so the terminal classification is durable.
      let record = await options.deliveries.get(owner, input.chatId, input.responseId);
      if (!record && input.segments && input.segments.length > 0) {
        const messageId = await resolveAssistantMessageId(input.chatId, input.runId);
        if (messageId) {
          const pending = await options.deliveries.recordPending(owner, {
            chatId: input.chatId,
            responseId: input.responseId,
            runId: input.runId,
            messageId,
            transportEpoch: input.transportEpoch,
            segments: input.segments.map((segment) => ({ ...segment })),
          }).catch((error: unknown) => {
            log("voice.delivery.backfill_failed", {
              sessionId: input.sessionId,
              error: error instanceof Error ? error.name : "UnknownError",
            });
            return null;
          });
          record = pending?.record ?? null;
        }
      }
      if (input.reason === "ended" || input.reason === "ack_lost" || input.reason === "unknown") {
        const classified = await options.deliveries.classifyUnknown(owner, {
          chatId: input.chatId,
          responseId: input.responseId,
          terminalReason: input.reason,
        });
        return classified.outcome === "classified" || classified.outcome === "ignored"
          ? { revision: classified.record?.revision ?? 0 }
          : "ignored";
      }
      if (!record) return "ignored";
      for (let attempt = 0; attempt < FENCED_WRITE_ATTEMPTS; attempt += 1) {
        const result = await options.deliveries.recordTerminal(owner, {
          chatId: input.chatId,
          responseId: input.responseId,
          state: input.reason === "complete" ? "complete" : "interrupted",
          terminalReason: input.reason,
          revision: record.revision,
          transportEpoch: input.transportEpoch,
        });
        if (result.outcome === "terminal" || result.outcome === "ignored") {
          return { revision: result.record?.revision ?? record.revision };
        }
        if (result.outcome !== "stale") return "ignored";
        record = result.record;
        if (!record) return "ignored";
      }
      return "ignored";
    },
  };

  const chatEvents: VoiceChatEventSource = {
    subscribe(input, listener) {
      const owner = ownerFor(input.principalId);
      const emit = (event: VoiceCanonicalChatEvent) => {
        try {
          listener(event);
        } catch (error: unknown) {
          log("voice.event.listener_failed", {
            sessionChatId: input.chatId,
            error: error instanceof Error ? error.name : "UnknownError",
          });
        }
      };
      const sink = options.repository.registerOutboxSink((incoming) => {
        if (incoming.event.chatId !== input.chatId) return;
        if (incoming.owner.type !== owner.type || incoming.owner.ownerId !== owner.ownerId) return;
        projectOutboxEvent(incoming.event, emit);
      });
      const subscription: VoiceChatEventSubscription = { close: () => sink.dispose() };
      return subscription;
    },
  };

  const runControl: VoiceRunControlPort = {
    async cancelRun(input) {
      try {
        const result = await options.orchestrator.cancelRun(
          ownerFor(input.principalId), input.chatId, input.runId,
        );
        return result.cancellation === "aborted" ? "cancelled" : "already_terminal";
      } catch (error: unknown) {
        log("voice.run_control.cancel_failed", {
          error: error instanceof Error ? error.name : "UnknownError",
        });
        return "unavailable";
      }
    },
    async cancelAction() {
      // Canonical Chat has no targeted action-cancellation surface yet; report
      // truthfully rather than pretending a granular cancel happened.
      return "unavailable";
    },
  };

  const chatAccess: VoiceChatAccessPort = {
    async requireAccess(input) {
      const record = await options.repository.get(ownerFor(input.principalId), input.chatId)
        .catch((error: unknown) => {
          throw error instanceof Error ? error : new Error("Chat access check failed");
        });
      if (!record) {
        throw new VoiceSessionError("not_found", "Chat unavailable", 404);
      }
    },
  };

  return { admission, delivery, chatEvents, runControl, chatAccess };
}

// ---------------------------------------------------------------------------
// Canonical outbox → voice event projection
// ---------------------------------------------------------------------------

const RUN_TERMINAL: Record<string, "succeeded" | "failed" | "cancelled"> = {
  "run.completed": "succeeded",
  "run.failed": "failed",
  "run.aborted": "cancelled",
};

function projectOutboxEvent(
  event: ChatOutboxEvent,
  emit: (event: VoiceCanonicalChatEvent) => void,
): void {
  const parsed = CanonicalChatContentSchema.safeParse(event.payload.streamContent ?? {
    record: { chat: { id: event.chatId, revision: -1 } },
  });
  const content = parsed.success ? parsed.data : undefined;
  const runId = typeof event.payload.runId === "string" ? event.payload.runId : undefined;

  const terminal = RUN_TERMINAL[event.eventType];
  if (terminal && runId) {
    emit({ type: "run.terminal", runId, state: terminal });
    return;
  }

  if (event.eventType === "queue.claimed" && runId) {
    // A queued voice turn was promoted to a canonical run. `queuedTurnId` is
    // the `qturn_` identity the session recorded at admission.
    const turnId = typeof event.payload.turnId === "string" ? event.payload.turnId : undefined;
    const queuedTurnId = typeof event.payload.queuedTurnId === "string"
      ? event.payload.queuedTurnId : undefined;
    if (turnId) {
      emit({
        type: "run.started",
        runId,
        canonicalTurnId: turnId,
        ...(queuedTurnId ? { canonicalQueuedTurnId: queuedTurnId } : {}),
      });
    }
    return;
  }

  if (event.eventType === "turn.accepted" && runId) {
    const run = content?.runs?.find((candidate) => candidate.id === runId);
    const turnId = run?.turnId
      ?? (typeof event.payload.turnId === "string" ? event.payload.turnId : undefined);
    if (turnId) emit({ type: "run.started", runId, canonicalTurnId: turnId });
    return;
  }

  if (event.eventType === "run.message" && content?.messageDelta) {
    const delta = content.messageDelta;
    // The delta message carries only the appended part; `partIndex` indexes
    // the full message's parts, not this payload array.
    const part = delta.message.parts[0];
    if (part?.type === "text" && runId) {
      emit({
        type: "assistant.text",
        runId,
        text: part.text,
        textStart: delta.offset,
        textEnd: delta.offset + part.text.length,
      });
    }
    return;
  }

  if (event.eventType === "run.activity" && content?.activities && runId) {
    const turnId = content.runs?.find((candidate) => candidate.id === runId)?.turnId;
    for (const activity of content.activities) {
      projectActivity(activity, runId, turnId, emit);
    }
  }
}

function projectActivity(
  activity: CanonicalChatRunActivity,
  runId: string,
  canonicalTurnId: string | undefined,
  emit: (event: VoiceCanonicalChatEvent) => void,
): void {
  switch (activity.type) {
    case "run.status":
      if (activity.status === "accepted" || activity.status === "running") {
        if (canonicalTurnId) emit({ type: "run.started", runId, canonicalTurnId });
      } else if (activity.status === "waiting_for_approval" || activity.status === "waiting_for_input") {
        emit({
          type: "operation.status",
          runId,
          label: activity.status === "waiting_for_approval" ? "Waiting for approval" : "Waiting for input",
          state: activity.status,
        });
      } else {
        emit({
          type: "run.terminal",
          runId,
          state: activity.status === "completed" ? "succeeded"
            : activity.status === "failed" ? "failed" : "cancelled",
        });
      }
      return;
    case "tool.progress":
      emit({
        type: "operation.status",
        runId,
        operationId: activity.toolCallId,
        label: activity.label,
        state: activity.status === "completed" ? "succeeded" : activity.status,
      });
      return;
    case "approval.requested":
      emit({
        type: "operation.status",
        runId,
        operationId: activity.approvalId,
        label: activity.title,
        state: "waiting_for_approval",
      });
      return;
    case "approval.resolved":
      emit({
        type: "operation.status",
        runId,
        operationId: activity.approvalId,
        label: "Approval resolved",
        state: activity.decision === "decline" || activity.decision === "cancel"
          ? "cancelled" : "succeeded",
      });
      return;
    case "agent.activity":
      emit({
        type: "operation.status",
        runId,
        operationId: activity.activityId,
        label: activity.label,
        state: activity.status === "completed" ? "succeeded"
          : activity.status === "failed" ? "failed"
          : activity.status === "cancelled" ? "cancelled"
          : activity.status === "partial" ? "outcome_unknown" : "running",
      });
      return;
    case "run.error":
      emit({
        type: "operation.status",
        runId,
        label: activity.error.safeMessage,
        state: "failed",
      });
      return;
    default:
      return;
  }
}
