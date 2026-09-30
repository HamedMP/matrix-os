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
  CanonicalChatModelSelection,
  CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import { CanonicalChatContentSchema, CanonicalChatRunPolicySchema } from "@matrix-os/contracts";
import {
  VoiceCapabilitySchema,
  type SafeVoiceErrorCode,
  type VoiceCapability,
  type VoiceRecoveryAction,
} from "@matrix-os/contracts/voice-session";
import type { CanonicalChatOrchestrator } from "../chat/orchestrator.js";
import { CanonicalChatOrchestrationError } from "../chat/orchestration-errors.js";
import {
  validateChatProviderSelection,
  voiceProviderSelectionRequirements,
} from "../chat/provider-catalog.js";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatOutboxEvent, ChatOwner } from "../chat/records.js";
import type { ChatVoiceDeliveryRepository } from "../chat/voice-delivery-repository.js";
import type { RequestPrincipal } from "../request-principal.js";
import type {
  VoiceAdmissionPort,
  VoiceCanonicalChatEvent,
  VoiceCanonicalDecision,
  VoiceChatAccessPort,
  VoiceChatEventSource,
  VoiceChatEventSubscription,
  VoiceDeliveryPort,
  VoiceDeliverySegmentInput,
  VoiceExecutionPolicy,
  VoiceRunControlPort,
  VoiceTurnAdmissionRequest,
  VoiceTurnAdmissionResult,
} from "./ports.js";
import { VoiceSessionError } from "./engine.js";

const MAX_UNHEARD_HINT_IDS = 200;
const FENCED_WRITE_ATTEMPTS = 3;

/**
 * The durable manifest stores canonical text offsets only — the engine's
 * ephemeral `segmentIndex` is dropped before repository writes (the strict
 * repo schema rejects unknown keys).
 */
function toRepoSegment(segment: VoiceDeliverySegmentInput) {
  return {
    segmentId: segment.segmentId,
    textStart: segment.textStart,
    textEnd: segment.textEnd,
    durationMs: segment.durationMs,
  };
}

/**
 * Repo-side delivery surface landing with the manifest-extension change.
 * Probed structurally so this adapter compiles before and after the
 * canonical repository gains the members; absent members degrade to the
 * failure shape the engine already treats as "delivery could not persist".
 */
interface VoiceDeliveryRepoExtension {
  extendManifest?(
    owner: ChatOwner,
    input: {
      chatId: string;
      responseId: string;
      appendSegments: ReturnType<typeof toRepoSegment>[];
      revision: number;
      transportEpoch: number;
    },
  ): Promise<"extended" | "stale" | "ignored" | "not_found" | { outcome?: string; record?: { revision: number } | null }>;
  adoptTransportEpoch?(
    owner: ChatOwner,
    input: { chatId: string; transportEpoch: number },
  ): Promise<{ outcome: "adopted" | "none"; adopted: number } | "adopted" | "none">;
}

function repoExtension(deliveries: ChatVoiceDeliveryRepository): VoiceDeliveryRepoExtension {
  return deliveries as ChatVoiceDeliveryRepository & VoiceDeliveryRepoExtension;
}

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
    ...(request.executionPolicy ? { executionPolicy: request.executionPolicy } : {}),
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
  actions?: import("../chat/action-authority.js").CanonicalActionAuthority;
  log?: (event: string, fields: Record<string, unknown>) => void;
}): {
  admission: VoiceAdmissionPort;
  delivery: VoiceDeliveryPort;
  chatEvents: VoiceChatEventSource;
  runControl: VoiceRunControlPort;
  chatAccess: VoiceChatAccessPort;
} {
  const log = options.log ?? (() => undefined);

  /** Canonical-truth read of a Chat's current revision. */
  const loadChatRevision = async (
    owner: ChatOwner, chatId: string,
  ): Promise<number | null> => {
    try {
      const record = await options.repository.get(owner, chatId);
      return record ? Number(record.chat.revision) : null;
    } catch (error: unknown) {
      log("voice.admission.revision_load_failed", {
        chatId,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  };

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
    async loadChatRevision(input) {
      return loadChatRevision(ownerFor(input.principalId), input.chatId);
    },

    async admitFinalTranscript(request) {
      const owner = ownerFor(request.principalId);
      const principal = principalFor(request);
      let unheardResponses: string[] = [];
      try {
        unheardResponses = await listUnheardDeliveryIds(options.deliveries, owner, request.chatId);
      } catch (error: unknown) {
        // Missing delivery truth cannot be treated as empty/heard context.
        log("voice.admission.unheard_lookup_failed", {
          sessionId: request.sessionId,
          error: error instanceof Error ? error.name : "UnknownError",
        });
        return failed("internal_failure", true, "retry_connection");
      }
      const hints = unheardResponses.length > 0
        ? { deliveryContext: { unheardResponses } }
        : undefined;
      // Admission fences on the freshest revision we can prove. A stale
      // baseRevision self-heals once: re-read canonical truth, retry once.
      let baseRevision = request.baseRevision;
      let input = turnInputFor(request);
      type AdmitOutcome = Awaited<ReturnType<CanonicalChatOrchestrator["admitTurn"]>>;
      const attemptAdmit = async (): Promise<{ admitted: AdmitOutcome | null; error: unknown }> => {
        try {
          const admitted = await options.orchestrator.admitTurn(
            principal, owner, request.chatId, input,
            hints ? { deliveryContext: hints.deliveryContext } : undefined,
          );
          return { admitted, error: null };
        } catch (error: unknown) {
          return { admitted: null, error };
        }
      };
      let attempt = await attemptAdmit();
      let refreshedRevision: number | null = null;
      const conflicts = (error: unknown) =>
        error instanceof CanonicalChatOrchestrationError
        && error.safeError.code === "chat_conflict";
      if (attempt.error && conflicts(attempt.error)) {
        refreshedRevision = await loadChatRevision(owner, request.chatId);
        if (refreshedRevision !== null && refreshedRevision !== baseRevision) {
          baseRevision = refreshedRevision;
          input = { ...input, baseRevision };
          attempt = await attemptAdmit();
        }
      }
      if (attempt.admitted) {
        const admitted = attempt.admitted;
        return {
          outcome: admitted.admission === "already_accepted" ? "already_accepted" : "sent",
          canonicalTurnId: admitted.turn.id,
          runId: admitted.run.id,
          revision: Number(admitted.record.chat.revision),
        };
      }
      const busy = attempt.error instanceof CanonicalChatOrchestrationError
        && attempt.error.safeError.code === "chat_busy";
      if (!busy) {
        const mapped = mapAdmissionError(attempt.error);
        // A refreshed revision is durable truth — surface it even on a
        // rejected admission so the engine's revision cache self-heals.
        if (refreshedRevision !== null && refreshedRevision > mapped.revision) {
          mapped.revision = refreshedRevision;
        }
        return mapped;
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
        segments: input.segments.map(toRepoSegment),
      });
      return { revision: result.record?.revision ?? 1 };
    },

    async extendManifest(input) {
      const owner = ownerFor(input.principalId);
      const repo = repoExtension(options.deliveries);
      if (typeof repo.extendManifest !== "function") {
        // Manifest extension has not landed repo-side; the segment cannot be
        // made durable, so report the write as not landed.
        log("voice.delivery.extend_unsupported", { sessionId: input.sessionId });
        return "ignored";
      }
      for (let attempt = 0; attempt < FENCED_WRITE_ATTEMPTS; attempt += 1) {
        const record = await options.deliveries.get(owner, input.chatId, input.responseId);
        if (!record) return "ignored";
        const result = await repo.extendManifest(owner, {
          chatId: input.chatId,
          responseId: input.responseId,
          appendSegments: input.appendSegments.map(toRepoSegment),
          revision: record.revision,
          transportEpoch: input.transportEpoch,
        });
        const outcome = typeof result === "string" ? result : result?.outcome;
        if (outcome === "extended") {
          const committed = typeof result === "object" ? result.record : null;
          return { revision: Number(committed?.revision ?? record.revision + 1) };
        }
        if (outcome !== "stale") return "ignored";
        // "stale" — re-read the fence inputs and retry within the bound.
      }
      return "ignored";
    },

    async adoptTransportEpoch(input) {
      const owner = ownerFor(input.principalId);
      const repo = repoExtension(options.deliveries);
      if (typeof repo.adoptTransportEpoch !== "function") {
        log("voice.delivery.adopt_unsupported", { sessionId: input.sessionId });
        return { outcome: "none" as const, adopted: 0 };
      }
      const result = await repo.adoptTransportEpoch(owner, {
        chatId: input.chatId,
        transportEpoch: input.transportEpoch,
      });
      if (typeof result === "string") {
        return { outcome: result === "adopted" ? "adopted" as const : "none" as const, adopted: 0 };
      }
      return {
        outcome: result.outcome === "adopted" ? "adopted" as const : "none" as const,
        adopted: Number(result.adopted ?? 0),
      };
    },

    async getDelivery(input) {
      const owner = ownerFor(input.principalId);
      const record = await options.deliveries.get(owner, input.chatId, input.responseId);
      return record
        ? { revision: Number(record.revision), transportEpoch: Number(record.transportEpoch) }
        : null;
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
          ...(input.segments ? { segments: input.segments.map(toRepoSegment) } : {}),
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
        const outcome: string = result.outcome;
        if (outcome === "acknowledged" || outcome === "duplicate") {
          return { revision: result.record?.revision ?? record.revision };
        }
        if (outcome === "out_of_order") return "out_of_order";
        if (outcome !== "stale") return "ignored";
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
            segments: input.segments.map(toRepoSegment),
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

  // Outbox sinks are a bounded process-wide resource (chat/outbox-delivery
  // caps registrations), so voice sessions multiplex over ONE shared sink:
  // each session subscribes into a bounded local set and receives only the
  // events for its own chat+owner. Without this, the Nth concurrent session
  // could exhaust the sink cap and fail with an untruthful internal_failure.
  const MAX_VOICE_SUBSCRIBERS = 256;
  const voiceSubscribers = new Set<{
    owner: ChatOwner;
    chatId: string;
    emit: (event: VoiceCanonicalChatEvent) => void;
  }>();
  let sharedSink: { dispose(): void } | null = null;
  const ensureSharedSink = () => {
    if (sharedSink) return;
    sharedSink = options.repository.registerOutboxSink((incoming) => {
      for (const subscriber of [...voiceSubscribers]) {
        if (incoming.event.chatId !== subscriber.chatId) continue;
        if (
          incoming.owner.type !== subscriber.owner.type
          || incoming.owner.ownerId !== subscriber.owner.ownerId
        ) {
          continue;
        }
        projectOutboxEvent(incoming.event, subscriber.emit);
      }
    });
  };

  const chatEvents: VoiceChatEventSource = {
    subscribe(input, listener) {
      if (voiceSubscribers.size >= MAX_VOICE_SUBSCRIBERS) {
        throw new VoiceSessionError("session_limit_reached", "Voice session limit reached", 429);
      }
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
      const subscriber = { owner, chatId: input.chatId, emit };
      voiceSubscribers.add(subscriber);
      ensureSharedSink();
      let closed = false;
      const subscription: VoiceChatEventSubscription = {
        close: () => {
          if (closed) return;
          closed = true;
          voiceSubscribers.delete(subscriber);
          if (voiceSubscribers.size === 0) {
            sharedSink?.dispose();
            sharedSink = null;
          }
        },
      };
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
    async cancelAction(input) {
      if (!options.actions) return "unavailable";
      try {
        const operation = await options.actions.cancelById({
          owner: ownerFor(input.principalId),
          chatId: input.chatId,
          actionId: input.actionId,
        });
        return operation.state === "cancelled" ? "cancelled" : "unknown";
      } catch (error: unknown) {
        log("voice.run_control.action_cancel_failed", {
          error: error instanceof Error ? error.name : "UnknownError",
        });
        return "unknown";
      }
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

// ---------------------------------------------------------------------------
// Canonical voice decision — the server-owned intersection a voice surface is
// allowed to see: the Chat's persisted Provider selection, that selection's
// canonical voice-route eligibility, one canonical interaction/permission
// mode pair, and a frozen conversation-only execution policy. No client field
// can widen it; no adapter-claimed actionMode survives it.
// ---------------------------------------------------------------------------

/** Canonical voice runs share one interaction/permission mode pair. */
const CANONICAL_VOICE_INTERACTION_MODE = "default";
const CANONICAL_VOICE_PERMISSION_MODE = "full_access";

/**
 * Frozen at session create and compared byte-for-byte on reconnect, so the
 * revision must be content-stable — it can never embed a catalog revision or
 * per-call nonce. `conversation_only` with an empty tool inventory is the
 * only policy the voice surface may carry: a live session stamps it onto every
 * turn that owns the Chat, so typed turns cannot widen it either.
 */
const CANONICAL_VOICE_EXECUTION_POLICY: VoiceExecutionPolicy = {
  revision: "voice_conversation_only_v1",
  actionMode: "conversation_only",
  workspaceScope: "apps",
  tools: [],
  delegation: false,
};

/**
 * A voice session may only carry a policy the loaded provider adapter can
 * actually enforce — structurally bound, delegation-free, and scoped to the
 * owner apps workspace. Anything else stays conversation-only.
 */
function qualifiedVoicePolicy(value: unknown): VoiceExecutionPolicy | undefined {
  const parsed = CanonicalChatRunPolicySchema.shape.executionPolicy.safeParse(value);
  if (!parsed.success) return undefined;
  const policy = parsed.data;
  if (!policy || policy.delegation || policy.actionMode === "conversation_only"
    || (policy.actionMode === "safe_reads" && policy.tools.length === 0)
    || policy.workspaceScope !== "apps") return undefined;
  return policy;
}

/**
 * Provider-route eligibility shared by capability advertisement, session
 * create, reconnect, and the canonical decision. The conversation-only
 * requirements always apply; the canonical interaction/permission modes are
 * part of the route check so an instance without them is never eligible.
 */
export function canonicalVoiceSelectionRequirements(): Parameters<
  typeof validateChatProviderSelection
>[0]["requirements"] {
  return {
    ...voiceProviderSelectionRequirements(),
    interactionMode: CANONICAL_VOICE_INTERACTION_MODE,
    permissionMode: CANONICAL_VOICE_PERMISSION_MODE,
  };
}

/**
 * Resolve the trusted canonical decision for one Chat selection against one
 * catalog snapshot. Returns `undefined` when no canonical route exists at all
 * (e.g. the Chat never persisted a selection) so callers fail closed rather
 * than inventing policy. A route that exists but is not voice-eligible still
 * returns a decision with `capability.status: "unavailable"` — advertisement
 * and session admission must agree.
 */
export function canonicalVoiceDecision(input: {
  selection: CanonicalChatModelSelection | undefined;
  catalog: CanonicalProviderCatalog;
  surface?: string;
  /**
   * Server-owned qualification result for the selected route — the exact
   * frozen policy the adapter can enforce, or nothing. Voice never invents
   * one; absent or unqualified providers stay conversation-only.
   */
  qualifiedPolicy?: unknown;
}): VoiceCanonicalDecision | undefined {
  if (!input.selection) return undefined;
  const qualifiedCandidate = qualifiedVoicePolicy(input.qualifiedPolicy);
  const eligible = validateChatProviderSelection({
    catalog: input.catalog,
    selection: input.selection,
    requirements: {
      ...canonicalVoiceSelectionRequirements(),
      ...(qualifiedCandidate ? { qualifiedPolicy: qualifiedCandidate } : {}),
    },
  });
  const qualified = eligible.ok ? qualifiedCandidate : undefined;
  const executionPolicy = qualified
    ?? CANONICAL_VOICE_EXECUTION_POLICY;
  const canInterrupt = eligible.ok
    && eligible.instance.supports.cancellation !== false
    && eligible.instance.supports.cancellation !== "none";
  const capability = VoiceCapabilitySchema.parse({
    contractVersion: 1,
    status: eligible.ok ? "available" : "unavailable",
    surface: input.surface ?? "web_desktop",
    // Canonical admission only rides the gateway-relayed transport; direct
    // WebRTC is not a canonical transport path.
    transportModes: eligible.ok ? ["relayed_websocket"] : [],
    turnModes: eligible.ok ? ["hands_free", "push_to_talk"] : [],
    supportsInterruption: canInterrupt,
    resume: !eligible.ok
      ? "unsupported"
      : eligible.instance.supports.resume ? "delivery_aware" : "rebuild_only",
    sessionOnly: "unsupported",
    actionMode: qualified ? executionPolicy.actionMode : "conversation_only",
    actionCancellation: qualified && executionPolicy.tools.length > 0 ? "run" : "none",
    supportsInputSelection: true,
    supportsOutputSelection: true,
    ...(eligible.ok ? {} : { reason: "provider_unavailable" as const }),
  });
  return {
    capability,
    selection: input.selection,
    interactionMode: CANONICAL_VOICE_INTERACTION_MODE,
    permissionMode: CANONICAL_VOICE_PERMISSION_MODE,
    // Fresh object per call; the engine freezes its own copy at create.
    executionPolicy: { ...executionPolicy, tools: [...executionPolicy.tools] },
  };
}
