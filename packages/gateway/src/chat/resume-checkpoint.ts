import type { Kysely } from "kysely";
import {
  CanonicalChatIdSchema,
  ChatContextSnapshotSchema,
  type CanonicalChatMessage,
  type CanonicalChatRunPolicy,
  type ChatContextSnapshot,
} from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";
import { transcript } from "./agent-context.js";
import type { CanonicalChatProviderAdapter } from "./provider-adapter.js";
import { toMessage, type ChatOwner } from "./records.js";
import type { ChatRepository } from "./repository.js";
import type { ChatCheckpointProvenance } from "./run-lifecycle-repository.js";

/**
 * Bounded window for retained/rebuild history slices. Matches the row and
 * byte budgets used by agent-context and queued-context history snapshots.
 */
const RETAINED_HISTORY_ROWS = 40;
const RETAINED_HISTORY_BYTES = 12_000;
const MAX_UNHEARD_HINTS = 200;

export type ChatResumeDecisionMode =
  /** A checkpoint covers all committed history — native resume is clean. */
  | "resume"
  /** A checkpoint predates committed history; resume plus `retainedHistory`. */
  | "resume_retained"
  /** A checkpoint exists but native resume is declined for this turn. */
  | "rebuild"
  /** No eligible checkpoint exists (or policy forbids one). */
  | "none";

export type ChatResumeDeclineReason =
  | "disposable_policy"
  | "canonical_actions_policy"
  | "no_checkpoint"
  | "eligibility_unavailable" // eligibility query failed — fail closed
  | "provenance_unverifiable" // selection carried no checkpoint provenance
  | "gap_unverifiable" // committed history coverage could not be evaluated
  | "retention_unsupported" // caller cannot carry retained canonical history
  | "retention_truncated" // the history gap exceeds the bounded retention window
  | "state_invalid"; // checkpoint state failed the adapter schema

/**
 * Resume decision for one admitted turn. `resumeState` is the parsed native
 * checkpoint when — and only when — the provider session provably contains
 * every committed canonical message this turn builds on (or the gap is
 * delivered alongside through `retainedHistory`). Canonical history is never
 * silently rewound: a checkpoint that predates committed history either
 * returns `resume_retained` with the unheard-safe gap slice, or declines to
 * `rebuild` so the run reconstructs context from Matrix-owned state.
 *
 * `retainedHistory` is a ready-to-attach `context.history` snapshot
 * projected through the delivery ledger: assistant text behind an
 * unresolved delivery is cut at its acknowledged `effective_text_end`, and
 * wholly unheard messages are omitted. Callers that can carry run context
 * should attach it for both `resume_retained` and `rebuild` modes.
 */
export interface ChatResumeDecision {
  mode: ChatResumeDecisionMode;
  resumeState?: unknown;
  /** Which checkpoint was selected and how far its session reached. */
  checkpoint?: ChatCheckpointProvenance;
  retainedHistory?: ChatContextSnapshot;
  /** Why a checkpoint-bearing decision declined native resume. */
  reason?: ChatResumeDeclineReason;
}

export class ChatResumeHistoryUnavailableError extends Error {
  constructor() {
    super("Heard-safe canonical history is unavailable");
    this.name = "ChatResumeHistoryUnavailableError";
  }
}

/** The eligibility selection, including mandatory checkpoint provenance. */
export interface ChatAdapterStateSelection {
  schemaVersion: number;
  state: unknown;
  executionRootFingerprint?: string;
  /**
   * Which checkpoint produced `state` and how much committed canonical
   * history its session provably covers. Selections that cannot name their
   * provenance are declined rather than trusted.
   */
  checkpoint?: ChatCheckpointProvenance;
}

export interface ChatResumeDecisionInput {
  // `kysely` stays optional so narrow test picks still compile; without it a
  // committed-history gap cannot be evaluated, so a checkpoint whose coverage
  // is unproven fails closed instead of silently rewinding canonical history.
  repository: {
    getLatestAdapterStateForChat(owner: ChatOwner, input: {
      chatId: string;
      driverKind: string;
      instanceId: string;
      schemaVersion: number;
      executionRootFingerprint: string | null;
      includeInterrupted?: boolean;
      unheardResponses?: readonly string[];
      sessionOnly?: boolean;
    }): Promise<ChatAdapterStateSelection | null>;
    kysely?: ChatRepository["kysely"] | null;
  };
  owner: ChatOwner;
  chatId: string;
  instanceId: string;
  adapter: CanonicalChatProviderAdapter;
  executionRootFingerprint: string | null;
  mode: "follow_up" | "retry";
  /** Immutable execution policy of the run being admitted. */
  runPolicy?: CanonicalChatRunPolicy;
  /** Caller-supplied delivery awareness: ids whose output was never heard. */
  deliveryContext?: { unheardResponses?: readonly string[] };
  /**
   * Whether the caller can attach `retainedHistory` to the admitted run's
   * context (the canonical retention channel). Defaults to false — callers
   * that cannot express retention must not resume past a history gap.
   */
  retainedHistorySupported?: boolean;
  /**
   * The turn's canonical history boundary (baseMessageSeq). Retained slices
   * are bounded to it; when omitted the gap is evaluated against all
   * committed history, which is the more conservative boundary.
   */
  historyBoundarySeq?: number;
}

type RepositoryKysely = NonNullable<ChatRepository["kysely"]>;

/**
 * Load the heard-safe slice of committed canonical history after
 * `afterSeq` (and at or before `throughSeq` when given). Assistant messages
 * behind unresolved deliveries are trimmed to the acknowledged text extent;
 * fully unheard messages drop out entirely, so retained context can never
 * re-introduce output the user did not hear.
 */
async function loadHeardHistorySlice(
  kysely: RepositoryKysely,
  owner: ChatOwner,
  chatId: string,
  afterSeq: number,
  throughSeq: number | undefined,
): Promise<{ snapshot: ChatContextSnapshot; truncated: boolean } | null> {
  const rows = await kysely.selectFrom("chat_messages as message")
    .innerJoin("chats as chat", "chat.id", "message.chat_id")
    .leftJoin("chat_voice_deliveries as delivery", (join) => join
      .onRef("delivery.chat_id", "=", "message.chat_id")
      .onRef("delivery.message_id", "=", "message.id"))
    .select([
      "message.id", "message.chat_id", "message.seq", "message.role", "message.purpose",
      "message.state", "message.turn_id", "message.run_id", "message.actor_id",
      "message.parts", "message.byte_count", "message.search_text", "message.created_at",
      "delivery.state as delivery_state", "delivery.effective_text_end",
    ])
    .where("message.chat_id", "=", chatId)
    .where("chat.owner_type", "=", owner.type)
    .where("chat.owner_id", "=", owner.ownerId)
    .where("message.state", "=", "committed")
    .where("message.seq", ">", afterSeq)
    .$if(throughSeq !== undefined, (query) => query.where("message.seq", "<=", throughSeq!))
    .orderBy("message.seq", "asc")
    .orderBy("delivery.response_id", "asc")
    .limit(RETAINED_HISTORY_ROWS * 4 + 1) // join fan-out bounded too
    .execute();
  if (rows.length === 0) return null;
  const titleRow = await kysely.selectFrom("chats").select("title")
    .where("id", "=", chatId).executeTakeFirst();
  if (!titleRow) return null;

  // Group the joined rows back into one entry per message, carrying the
  // heard extent imposed by its unresolved deliveries (if any).
  const messages: { message: CanonicalChatMessage; heardExtent: number }[] = [];
  const byId = new Map<string, number>();
  let rowTruncated = false;
  for (const row of rows) {
    let slot = byId.get(row.id);
    if (slot === undefined) {
      if (messages.length >= RETAINED_HISTORY_ROWS) {
        rowTruncated = true;
        break;
      }
      slot = messages.length;
      byId.set(row.id, slot);
      messages.push({ message: toMessage(row), heardExtent: Number.POSITIVE_INFINITY });
    }
    // A delivery row other than `complete` bounds heard text to its
    // acknowledged offset; multiple rows take the most conservative bound.
    if (row.delivery_state !== null && row.delivery_state !== "complete") {
      const extent = row.effective_text_end === null ? 0 : Number(row.effective_text_end);
      messages[slot]!.heardExtent = Math.min(messages[slot]!.heardExtent, extent);
    }
  }

  const projected = messages.flatMap(({ message, heardExtent }) => {
    if (heardExtent === Number.POSITIVE_INFINITY) return [message];
    const text = message.parts
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("\n")
      .slice(0, heardExtent);
    if (!text) return [];
    return [{ ...message, parts: [{ type: "text" as const, text }] }];
  });
  const rendered = transcript(projected, RETAINED_HISTORY_BYTES);
  return {
    snapshot: ChatContextSnapshotSchema.parse({
      chatId,
      title: titleRow.title,
      throughSeq: messages.at(-1)?.message.seq ?? afterSeq,
      text: rendered.text,
      truncated: rendered.truncated || rowTruncated,
    }),
    truncated: rendered.truncated || rowTruncated,
  };
}

function rebuild(
  reason: ChatResumeDeclineReason,
  retainedHistory?: ChatContextSnapshot,
  checkpoint?: ChatCheckpointProvenance,
): ChatResumeDecision {
  return {
    mode: "rebuild",
    reason,
    ...(retainedHistory ? { retainedHistory } : {}),
    ...(checkpoint ? { checkpoint } : {}),
  };
}

/**
 * Delivery-aware native-checkpoint decision shared by immediate follow-ups,
 * durable queued turns, and Retry.
 *
 * Eligibility is evaluated inside the eligibility query itself (database-side
 * `NOT EXISTS` over `chat_voice_deliveries` plus caller hints), so a bounded
 * id list can never silently truncate coverage. Fail-closed throughout: any
 * failure loading eligibility, provenance, or the retained-history gap
 * declines native resume instead of proceeding without exclusions, and the
 * selected checkpoint is always reported with the canonical history boundary
 * it provably covers.
 */
export async function loadChatResumeDecision(input: ChatResumeDecisionInput): Promise<ChatResumeDecision> {
  const kysely = input.repository.kysely ?? null;
  const chatId = CanonicalChatIdSchema.parse(input.chatId);

  /** Best-effort rebuild context: the recent heard-safe canonical history. */
  const rebuildContext = async (): Promise<ChatContextSnapshot | undefined> => {
    if (!kysely) return undefined;
    try {
      const slice = await loadHeardHistorySlice(
        kysely, input.owner, chatId, 0, input.historyBoundarySeq,
      );
      return slice?.snapshot;
    } catch (error: unknown) {
      console.warn("[chat] rebuild history projection failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return undefined;
    }
  };

  // Constrained action runners are single-use: their grant and isolated home
  // belong to one run. Rebuild from Matrix-owned heard-safe history just as
  // for disposable checkpoints, without reusing a prior run's native authority.
  const canonicalActions = input.runPolicy?.executionPolicy?.actionMode === "canonical_actions";
  if (input.runPolicy?.nativeCheckpointPolicy === "disposable"
    || input.runPolicy?.memoryMode === "session_only" || canonicalActions) {
    const reason = canonicalActions ? "canonical_actions_policy" : "disposable_policy";
    if ((input.historyBoundarySeq ?? 0) === 0) {
      return { mode: "none", reason };
    }
    const retainedHistory = await rebuildContext();
    if (!retainedHistory) throw new ChatResumeHistoryUnavailableError();
    return rebuild(reason, retainedHistory);
  }

  if (!input.adapter.resume) return rebuild("no_checkpoint", await rebuildContext());

  const unheardResponses = (input.deliveryContext?.unheardResponses ?? [])
    .slice(0, MAX_UNHEARD_HINTS);
  let previous: ChatAdapterStateSelection | null;
  try {
    previous = await input.repository.getLatestAdapterStateForChat(input.owner, {
      chatId,
      driverKind: input.adapter.driverKind,
      instanceId: input.instanceId,
      schemaVersion: input.adapter.stateSchemaVersion,
      executionRootFingerprint: input.executionRootFingerprint,
      includeInterrupted: input.mode === "follow_up",
      // session_only was declined above; ordinary runs leave this off.
      ...(unheardResponses.length > 0 ? { unheardResponses } : {}),
    });
  } catch (error: unknown) {
    // Fail closed: eligibility could not be evaluated, so no checkpoint is
    // usable for this turn — never proceed without the delivery exclusions.
    console.warn("[chat] checkpoint eligibility evaluation failed; disabling native resume", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return rebuild("eligibility_unavailable", await rebuildContext());
  }
  if (!previous) {
    if ((input.historyBoundarySeq ?? 0) === 0) {
      return { mode: "none", reason: "no_checkpoint" };
    }
    const retainedHistory = await rebuildContext();
    if (!retainedHistory) throw new ChatResumeHistoryUnavailableError();
    return rebuild("no_checkpoint", retainedHistory);
  }

  // Provenance is mandatory: a selection that cannot name its checkpoint and
  // coverage boundary cannot be trusted not to rewind canonical history.
  const checkpoint = previous.checkpoint;
  if (!checkpoint) {
    console.warn("[chat] checkpoint selection carried no provenance; disabling native resume");
    return rebuild("provenance_unverifiable", await rebuildContext());
  }

  let resumeState: unknown;
  try {
    resumeState = input.adapter.parseState(previous.state);
  } catch (error: unknown) {
    console.warn("[chat] checkpoint state failed adapter parsing; disabling native resume", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return rebuild("state_invalid", await rebuildContext(), checkpoint);
  }

  const coveredThrough = checkpoint.coveredThroughSeq;
  const boundary = input.historyBoundarySeq;
  if (boundary !== undefined && coveredThrough >= boundary) {
    // The resumed session provably contains all committed history this turn
    // builds on — nothing to retain.
    return { mode: "resume", resumeState, checkpoint };
  }

  // The checkpoint may predate committed history. Resolve the gap — bounded
  // and heard-safe — before trusting the native session.
  if (!kysely) {
    // Without database access the gap cannot be evaluated; resume is declined
    // rather than risking a silent rewind.
    return rebuild("gap_unverifiable", undefined, checkpoint);
  }
  let gap: Awaited<ReturnType<typeof loadHeardHistorySlice>>;
  try {
    gap = await loadHeardHistorySlice(kysely, input.owner, chatId, coveredThrough, boundary);
  } catch (error: unknown) {
    console.warn("[chat] retained-history gap evaluation failed; disabling native resume", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return rebuild("gap_unverifiable", await rebuildContext(), checkpoint);
  }
  if (!gap) return { mode: "resume", resumeState, checkpoint }; // coverage gap is empty

  // A real gap exists. Retain it alongside the resumed session when the
  // caller can carry canonical history and the whole gap fits the window;
  // otherwise the checkpoint would silently rewind committed history, so
  // native resume is declined and the run rebuilds instead.
  if (!input.retainedHistorySupported) {
    return rebuild("retention_unsupported", await rebuildContext(), checkpoint);
  }
  if (gap.truncated) {
    return rebuild("retention_truncated", await rebuildContext(), checkpoint);
  }
  return {
    mode: "resume_retained",
    resumeState,
    checkpoint,
    retainedHistory: gap.snapshot,
  };
}

/**
 * Legacy wrapper kept for callers that cannot attach retained history to a
 * run yet: returns the parsed native checkpoint, or `undefined` when native
 * resume is ineligible — including whenever committed history exists beyond
 * the checkpoint's coverage, because such callers cannot retain the gap.
 */
export async function loadChatResumeState(
  input: Omit<ChatResumeDecisionInput, "retainedHistorySupported" | "historyBoundarySeq">,
): Promise<unknown> {
  const decision = await loadChatResumeDecision({ ...input, retainedHistorySupported: false });
  return decision.resumeState;
}
