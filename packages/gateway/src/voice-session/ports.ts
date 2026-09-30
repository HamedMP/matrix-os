/**
 * Voice session ports (Layer 4 seam).
 *
 * These are the narrow boundaries between the voice session engine and the
 * canonical Chat authority, delivery ledger, capability policy, and realtime
 * clock. The orchestrator binds real implementations (canonical admission
 * through `admitCanonicalTurn`, the delivery repository, the canonical event
 * stream); tests bind fakes. No port may be satisfied by client-asserted
 * state, and none return raw provider errors — implementations map to the
 * safe error vocabulary defined by `@matrix-os/contracts/voice-session`.
 */
import type {
  CanonicalChatModelSelection,
  CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import type { PrincipalSource } from "../request-principal.js";
import type {
  CanonicalOperationState,
  SafeVoiceErrorCode,
  VoiceCapability,
  VoiceRecoveryAction,
} from "@matrix-os/contracts/voice-session";

export type VoiceMemoryMode = "ordinary" | "session_only";

/** Wall-clock + scheduler seam so tests can drive virtual time explicitly. */
export interface VoiceTimer {
  cancel(): void;
}

export interface VoiceClock {
  /** Monotonic-or-wall milliseconds used for timestamps and lease expiry. */
  now(): number;
  /** Schedule `fn` at or after `delayMs`; must return a cancel handle. */
  after(delayMs: number, fn: () => void): VoiceTimer;
}

export function createSystemVoiceClock(): VoiceClock {
  return {
    now: () => Date.now(),
    after: (delayMs, fn) => {
      const handle = setTimeout(fn, delayMs);
      handle.unref?.();
      return { cancel: () => clearTimeout(handle) };
    },
  };
}

/**
 * Frozen canonical admission snapshot for one spoken turn. Fields mirror the
 * canonical turn admission input so the bound implementation can call
 * `admitCanonicalTurn` (or its queue/steer siblings) without re-deriving
 * policy from live session state.
 */
export interface VoiceTurnAdmissionRequest {
  /** Session producing this turn — binds admission to the owning Chat/principal. */
  sessionId: string;
  /** Canonical owning Chat the session is bound to. */
  chatId: string;
  /** Trusted runtime principal for the session owner. */
  principalId: string;
  /** Principal provenance captured at session create; drives catalog trust. */
  principalSource: PrincipalSource;
  /** Stable idempotent request identity (`req_…`), generated once per turn. */
  clientRequestId: string;
  /** Provider/STT final identity; dedupes duplicate and reordered finals. */
  finalityId: string;
  /** Engine-assigned monotonic capture order for this session. */
  localOrder: number;
  /** Chat revision frozen at `capture.start`; canonical admission revalidates. */
  baseRevision: number;
  /** Final recognized user text. Never provisional, never a correction. */
  transcript: string;
  selection: CanonicalChatModelSelection;
  interactionMode: string;
  permissionMode: string;
  memoryMode: VoiceMemoryMode;
  executionRoot?: CanonicalCreateChatTurnRequest["executionRoot"];
}

export type VoiceTurnAdmissionOutcome =
  | "sent"
  | "queued"
  | "steered"
  | "already_accepted"
  | "rejected"
  | "failed";

export interface VoiceTurnAdmissionResult {
  outcome: VoiceTurnAdmissionOutcome;
  /** Canonical `cturn_` identity once admitted (sent/steered/already). */
  canonicalTurnId?: string;
  /** Canonical `qturn_` identity while the turn waits in the queue. */
  canonicalQueuedTurnId?: string;
  /** Canonical `run_` identity when the turn dispatched or steered a run. */
  runId?: string;
  /** Chat revision observed by the admission authority. */
  revision: number;
  /** Safe denial detail for rejected/failed outcomes. */
  error?: { code: SafeVoiceErrorCode; retryable: boolean; recovery: VoiceRecoveryAction };
}

/**
 * The only path a spoken final transcript may take into canonical Chat.
 * Implementations must admit at most once per `clientRequestId`/`finalityId`
 * and return the prior outcome for duplicates.
 */
export interface VoiceAdmissionPort {
  admitFinalTranscript(request: VoiceTurnAdmissionRequest): Promise<VoiceTurnAdmissionResult>;
  /**
   * Canonical-truth read of the owning Chat's current revision. The engine
   * calls this lazily before the first admission so a frozen baseRevision of
   * 0 cannot reject the first voice turn on a chat that already has history.
   * Returns null when the Chat record is unreadable; admission revalidates.
   */
  loadChatRevision?(input: {
    chatId: string;
    principalId: string;
  }): Promise<number | null>;
}

export type VoiceDeliveryState =
  | "pending"
  | "playing"
  | "complete"
  | "interrupted"
  | "unknown";

export type VoiceDeliveryTerminalReason =
  | "complete"
  | "interrupted"
  | "ended"
  | "ack_lost"
  | "unknown";

/** Engine-side view of one manifest segment (ordered, canonical offsets). */
export interface VoiceDeliverySegmentInput {
  segmentId: string;
  segmentIndex: number;
  textStart: number;
  textEnd: number;
  durationMs: number;
}

/**
 * Idempotent post-run delivery ledger. The canonical implementation owns its
 * own repository transaction; it never reopens run execution state, and a
 * missing/late terminal write conservatively leaves delivery `unknown`
 * (never "fully heard"). All calls carry the current transport epoch so
 * stale connections cannot advance state.
 */
export interface VoiceDeliveryPort {
  /**
   * Create the `pending` record before the first playback-eligible segment.
   * `segments` is the engine's current ledger snapshot (ordered segment ids
   * with canonical text offsets) and always contains at least the first
   * segment — a pending row with an empty manifest is never written.
   * Later acks carry exact boundaries.
   */
  recordPending(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    responseId: string;
    runId: string;
    transportEpoch: number;
    segments: readonly VoiceDeliverySegmentInput[];
  }): Promise<{ revision: number }>;

  /**
   * Append newly synthesized segments to an existing pending/playing record.
   * The durable manifest must cover every segment before the engine asks the
   * adapter to synthesize it. Returns `"ignored"` for stale epochs/revisions,
   * terminal records, or unknown responseIds.
   */
  extendManifest(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    responseId: string;
    transportEpoch: number;
    deliveryRevision: number;
    appendSegments: readonly VoiceDeliverySegmentInput[];
  }): Promise<{ revision: number } | "ignored">;

  /**
   * Report audio actually emitted to the transport. The stored boundary caps
   * future `playedThroughMs` claims — a client cannot ack into undelivered audio.
   * Returns `"ignored"` for stale epochs/revisions or unknown records.
   */
  recordDelivered(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    responseId: string;
    transportEpoch: number;
    deliveredThroughMs: number;
    deliveryRevision: number;
  }): Promise<{ revision: number } | "ignored">;

  /**
   * Advance delivery to the end of exactly one acknowledged segment.
   * Returns `"ignored"` for stale epochs/revisions or unknown records and
   * `"out_of_order"` when the segment skips over unacknowledged predecessors
   * (acks must be contiguous in manifest order). `effectiveTextEnd` is the
   * canonical text offset of that segment's end; `playedThroughMs` never
   * exceeds delivered audio.
   */
  acknowledge(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    responseId: string;
    segmentId: string;
    transportEpoch: number;
    playedThroughMs: number;
    deliveryRevision: number;
    effectiveTextEnd: number;
  }): Promise<{ revision: number } | "ignored" | "out_of_order">;

  /**
   * Adopt a freshly committed transport epoch for every still-open delivery
   * of this Chat after a reconnect. Without adoption the durable rows keep
   * the dead epoch and every subsequent fenced write goes stale. Returns the
   * count of rows moved forward; `"none"` means nothing needed adopting.
   */
  adoptTransportEpoch(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    transportEpoch: number;
  }): Promise<{ outcome: "adopted" | "none"; adopted: number }>;

  /**
   * Re-read one delivery record's fence inputs (used to resync
   * `deliveryRevision` after an epoch adoption bumped the row revision).
   */
  getDelivery(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    responseId: string;
  }): Promise<{ revision: number; transportEpoch: number } | null>;

  /**
   * Write the terminal delivery state once. Returns `"ignored"` when a
   * terminal/unknown record already exists or the epoch is stale.
   */
  recordTerminal(input: {
    sessionId: string;
    chatId: string;
    principalId: string;
    responseId: string;
    /** Canonical run the response was synthesized from (backfill identity). */
    runId: string;
    transportEpoch: number;
    reason: VoiceDeliveryTerminalReason;
    effectiveThroughMs: number;
    effectiveTextEnd: number;
    /** Last ledger revision this session observed; absent when pending never committed. */
    deliveryRevision?: number;
    /** Ledger segments for conservative backfill when no pending row exists. */
    segments?: readonly VoiceDeliverySegmentInput[];
  }): Promise<{ revision: number } | "ignored">;
}

/** Canonical run events the voice channel may consume for synthesis/status. */
export type VoiceCanonicalChatEvent =
  | {
      type: "run.started";
      runId: string;
      canonicalTurnId: string;
      /** Set when a queued voice turn is promoted: links to its `qturn_` id. */
      canonicalQueuedTurnId?: string;
    }
  | {
      type: "operation.status";
      runId: string;
      operationId?: string;
      label: string;
      state: CanonicalOperationState;
    }
  | {
      /** Assistant text slice eligible for spoken synthesis. */
      type: "assistant.text";
      runId: string;
      text: string;
      textStart: number;
      textEnd: number;
    }
  | { type: "run.terminal"; runId: string; state: CanonicalOperationState };

export interface VoiceChatEventSubscription {
  close(): void;
}

/**
 * Subscription to canonical Chat events for one chat. Implementations
 * project the canonical stream; the engine filters to runs it owns.
 */
export interface VoiceChatEventSource {
  subscribe(
    input: { chatId: string; principalId: string },
    listener: (event: VoiceCanonicalChatEvent) => void,
  ): VoiceChatEventSubscription;
}

/**
 * Canonical run/action cancellation. Optional: when absent the engine only
 * stops local synthesis/playback and reports truthfully.
 */
export interface VoiceRunControlPort {
  cancelRun(input: {
    chatId: string;
    runId: string;
    principalId: string;
    reason: "user" | "interruption";
  }): Promise<"cancelled" | "already_terminal" | "unavailable">;
  cancelAction(input: {
    chatId: string;
    actionId: string;
    principalId: string;
  }): Promise<"cancelled" | "unavailable" | "unknown">;
}

/**
 * Exact-chat authorization check performed by canonical Chat services.
 * Implementations throw typed errors; routes map them to safe responses.
 */
export interface VoiceChatAccessPort {
  requireAccess(input: {
    principalId: string;
    chatId: string;
    level: "read" | "write";
  }): Promise<void> | void;
}

/** Safe capability projection. Output is schema-validated before clients. */
export interface VoiceCapabilityPort {
  capabilities(input: {
    principalId: string;
    chatId: string;
    surface?: string;
  }): Promise<VoiceCapability> | VoiceCapability;
}
