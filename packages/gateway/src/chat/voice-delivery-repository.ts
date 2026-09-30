/**
 * CanonicalVoiceDelivery (specs/535-aoede-rewrite, FR-034A): the durable,
 * idempotent post-run record of what assistant audio the owner actually heard.
 * Records never contain audio bytes.
 *
 * Invariants enforced here:
 * - A record is inserted `pending` before the first audio segment is eligible
 *   for playback; `ON CONFLICT DO NOTHING` makes registration idempotent.
 * - Acknowledgements are conditional writes fenced by (chat_id, response_id,
 *   revision, transport_epoch) and only ever advance: `effective_text_end`
 *   moves to the acknowledged segment's `textEnd` and never beyond it,
 *   `played_through_ms` stays `<= delivered_through_ms`, re-acking the
 *   same or an earlier segment is a no-op success, and acks must be
 *   contiguous in manifest order — acking past an unacknowledged
 *   predecessor returns `out_of_order` so unheard text can never be
 *   skipped into a `complete` record.
 * - The manifest grows through `extendManifest`: later assistant clauses
 *   append whole segments to the tail under the same revision/epoch fence;
 *   the merged manifest must stay schema-valid (unique ids, non-decreasing
 *   offsets) or the write is rejected as a conflict, never partially stored.
 * - `adoptTransportEpoch` moves every non-terminal row of a chat to a freshly
 *   minted epoch in one statement (forward-only, revision bumped). Reconnects
 *   re-fence open deliveries so writes holding the dead epoch lose; a
 *   mid-flight fenced write serializes on the same row locks and goes stale
 *   if adoption commits first — no extra coordination is needed.
 * - Terminal states are absorbing: once complete/interrupted/unknown the
 *   record can never return to pending/playing or be overwritten by a
 *   different terminal value; late writes return the existing record with an
 *   `ignored` outcome.
 * - `complete` REQUIRES every manifest segment acknowledged; an incomplete
 *   ack trail rejects the write — no silent downgrade, the engine chooses
 *   between `interrupted` and `unknown` explicitly.
 * - Crash/lost-ack recovery is the explicit `classifyUnknown` path: it fences
 *   only on non-terminal state (the dead epoch cannot be matched) and
 *   conservatively leaves every unacknowledged segment excluded.
 * - `recordPending` re-registration with the same immutable identity
 *   (runId, messageId, segments) and a newer `transportEpoch` adopts the
 *   epoch forward while non-terminal — how a reconnect keeps acknowledging an
 *   in-flight response. Identity mismatch throws ChatConflictError.
 */
import { Kysely, sql, type Selectable, type Transaction, type Updateable } from "kysely";
import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalOwnerScopeSchema } from "@matrix-os/contracts";
import type { ChatDatabase, ChatVoiceDeliveriesTable } from "./database.js";
import { ChatConflictError, ChatNotFoundError } from "./errors.js";
import { asIso, jsonb, parseJson, type ChatOwner } from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;

const MAX_SEGMENTS = 1024;
const MAX_TEXT_OFFSET = 16 * 1024 * 1024;
const MAX_STREAM_MS = 24 * 60 * 60 * 1000;
const MAX_BOUNDARIES = 256;
const SAFE_REF = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const FENCED_COUNTER = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const STREAM_MS = z.number().int().min(0).max(MAX_STREAM_MS);
const NON_TERMINAL_STATES = ["pending", "playing"] as const;
const TERMINAL_STATES = new Set<VoiceDeliveryState>(["complete", "interrupted", "unknown"]);

export type VoiceDeliveryState = "pending" | "playing" | "complete" | "interrupted" | "unknown";
export type VoiceDeliveryTerminalState = "complete" | "interrupted" | "unknown";

export const VoiceDeliverySegmentSchema = z.object({
  segmentId: SAFE_REF,
  textStart: z.number().int().min(0).max(MAX_TEXT_OFFSET),
  textEnd: z.number().int().min(0).max(MAX_TEXT_OFFSET),
  durationMs: STREAM_MS,
}).strict().refine((segment) => segment.textEnd >= segment.textStart, {
  message: "segment textEnd must not precede textStart",
});

/** Ordered segment manifest; ids unique, canonical text offsets non-decreasing. */
export const VoiceDeliverySegmentsSchema = z.array(VoiceDeliverySegmentSchema)
  .min(1).max(MAX_SEGMENTS)
  .superRefine((segments, context) => {
    const seen = new Set<string>();
    let previousStart = -1;
    let previousEnd = -1;
    for (const [index, segment] of segments.entries()) {
      if (seen.has(segment.segmentId)) {
        context.addIssue({ code: "custom", message: "Duplicate segmentId", path: [index, "segmentId"] });
      }
      seen.add(segment.segmentId);
      if (segment.textStart < previousStart || segment.textEnd < previousEnd) {
        context.addIssue({
          code: "custom",
          message: "Segments must be ordered by non-decreasing text offsets",
          path: [index],
        });
      }
      previousStart = segment.textStart;
      previousEnd = segment.textEnd;
    }
  });

export type VoiceDeliverySegment = z.infer<typeof VoiceDeliverySegmentSchema>;

export interface VoiceDeliveryRecord {
  chatId: string;
  responseId: string;
  runId: string;
  messageId: string;
  state: VoiceDeliveryState;
  revision: number;
  segments: VoiceDeliverySegment[];
  acknowledgedSegment: string | null;
  deliveredThroughMs: number;
  playedThroughMs: number;
  effectiveTextEnd: number;
  transportEpoch: number;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceDeliveryPendingInput {
  chatId: string;
  responseId: string;
  runId: string;
  messageId: string;
  transportEpoch: number;
  segments: VoiceDeliverySegment[];
}

export interface VoiceDeliveryAcknowledgeInput {
  chatId: string;
  responseId: string;
  segmentId: string;
  playedThroughMs: number;
  revision: number;
  transportEpoch: number;
}

export interface VoiceDeliveryExtendInput {
  chatId: string;
  responseId: string;
  /** Segments appended to the tail; ids unique, offsets non-decreasing. */
  appendSegments: VoiceDeliverySegment[];
  revision: number;
  transportEpoch: number;
}

export interface VoiceDeliveryAdoptEpochInput {
  chatId: string;
  transportEpoch: number;
}

export interface VoiceDeliveryDeliveredInput {
  chatId: string;
  responseId: string;
  deliveredThroughMs: number;
  revision: number;
  transportEpoch: number;
}

export interface VoiceDeliveryTerminalInput {
  chatId: string;
  responseId: string;
  state: VoiceDeliveryTerminalState;
  terminalReason?: string;
  revision: number;
  transportEpoch: number;
}

export interface VoiceDeliveryClassifyInput {
  chatId: string;
  responseId: string;
  terminalReason?: string;
}

/** Outcome discriminators; every result carries the record as last committed. */
export type VoiceDeliveryPendingOutcome = "created" | "existing";
export type VoiceDeliveryAcknowledgeOutcome =
  | "acknowledged" // advanced to the next contiguous segment
  | "duplicate" // same/earlier segment replay — idempotent no-op success
  | "out_of_order" // segment skips unacknowledged predecessors — no mutation
  | "stale" // revision/epoch fence mismatch — no mutation
  | "unknown_segment" // segment not in the manifest — no mutation
  | "ignored" // terminal record — no mutation
  | "not_found";
export type VoiceDeliveryExtendOutcome =
  | "extended" // segments appended and revision bumped
  | "stale" // revision/epoch fence mismatch — no mutation
  | "ignored" // terminal record — no mutation
  | "not_found";
export type VoiceDeliveryDeliveredOutcome =
  | "delivered" // delivery boundary advanced
  | "duplicate" // boundary not ahead of the stored one — no-op success
  | "stale"
  | "ignored"
  | "not_found";
export type VoiceDeliveryTerminalOutcome =
  | "terminal" // terminal state recorded
  | "ignored" // already terminal — absorbing, returns existing record
  | "stale"
  | "rejected" // `complete` claimed with unacknowledged segments
  | "not_found";
export type VoiceDeliveryClassifyOutcome = "classified" | "ignored" | "not_found";

export interface VoiceDeliveryResult<Outcome extends string> {
  outcome: Outcome;
  record: VoiceDeliveryRecord | null;
}

/** Narrow port consumed by the gateway voice engine. */
export interface VoiceDeliveryPort {
  recordPending(
    owner: ChatOwner,
    input: VoiceDeliveryPendingInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryPendingOutcome>>;
  extendManifest(
    owner: ChatOwner,
    input: VoiceDeliveryExtendInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryExtendOutcome>>;
  acknowledge(
    owner: ChatOwner,
    input: VoiceDeliveryAcknowledgeInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryAcknowledgeOutcome>>;
  adoptTransportEpoch(
    owner: ChatOwner,
    input: VoiceDeliveryAdoptEpochInput,
  ): Promise<{ outcome: "adopted" | "none"; adopted: number }>;
  recordDelivered(
    owner: ChatOwner,
    input: VoiceDeliveryDeliveredInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryDeliveredOutcome>>;
  recordTerminal(
    owner: ChatOwner,
    input: VoiceDeliveryTerminalInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryTerminalOutcome>>;
  classifyUnknown(
    owner: ChatOwner,
    input: VoiceDeliveryClassifyInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryClassifyOutcome>>;
  get(owner: ChatOwner, chatId: string, responseId: string): Promise<VoiceDeliveryRecord | null>;
  listEffectiveBoundaries(owner: ChatOwner, chatId: string): Promise<ReadonlyMap<string, number>>;
}

const RecordPendingInputSchema = z.object({
  chatId: CanonicalChatIdSchema,
  responseId: SAFE_REF,
  runId: SAFE_REF,
  messageId: SAFE_REF,
  transportEpoch: FENCED_COUNTER,
  segments: VoiceDeliverySegmentsSchema,
}).strict();

const AcknowledgeInputSchema = z.object({
  chatId: CanonicalChatIdSchema,
  responseId: SAFE_REF,
  segmentId: SAFE_REF,
  playedThroughMs: STREAM_MS,
  revision: FENCED_COUNTER,
  transportEpoch: FENCED_COUNTER,
}).strict();

const ExtendInputSchema = z.object({
  chatId: CanonicalChatIdSchema,
  responseId: SAFE_REF,
  appendSegments: VoiceDeliverySegmentsSchema,
  revision: FENCED_COUNTER,
  transportEpoch: FENCED_COUNTER,
}).strict();

const AdoptEpochInputSchema = z.object({
  chatId: CanonicalChatIdSchema,
  transportEpoch: FENCED_COUNTER,
}).strict();

const DeliveredInputSchema = z.object({
  chatId: CanonicalChatIdSchema,
  responseId: SAFE_REF,
  deliveredThroughMs: STREAM_MS,
  revision: FENCED_COUNTER,
  transportEpoch: FENCED_COUNTER,
}).strict();

const TerminalInputSchema = z.object({
  chatId: CanonicalChatIdSchema,
  responseId: SAFE_REF,
  state: z.enum(["complete", "interrupted", "unknown"]),
  terminalReason: SAFE_REF.optional(),
  revision: FENCED_COUNTER,
  transportEpoch: FENCED_COUNTER,
}).strict();

const ClassifyInputSchema = z.object({
  chatId: CanonicalChatIdSchema,
  responseId: SAFE_REF,
  terminalReason: SAFE_REF.optional(),
}).strict();

function readSegments(row: Selectable<ChatVoiceDeliveriesTable>): VoiceDeliverySegment[] | null {
  const parsed = VoiceDeliverySegmentsSchema.safeParse(parseJson(row.segments));
  return parsed.success ? parsed.data : null;
}

function segmentsEqual(
  stored: readonly VoiceDeliverySegment[] | null,
  input: readonly VoiceDeliverySegment[],
): boolean {
  return stored !== null && stored.length === input.length
    && input.every((segment, index) => {
      const candidate = stored[index]!;
      return candidate.segmentId === segment.segmentId
        && candidate.textStart === segment.textStart
        && candidate.textEnd === segment.textEnd
        && candidate.durationMs === segment.durationMs;
    });
}

function toVoiceDeliveryRecord(row: Selectable<ChatVoiceDeliveriesTable>): VoiceDeliveryRecord {
  return {
    chatId: row.chat_id,
    responseId: row.response_id,
    runId: row.run_id,
    messageId: row.message_id,
    state: row.state,
    revision: Number(row.revision),
    segments: readSegments(row) ?? [],
    acknowledgedSegment: row.acknowledged_segment,
    deliveredThroughMs: Number(row.delivered_through_ms),
    playedThroughMs: Number(row.played_through_ms),
    effectiveTextEnd: Number(row.effective_text_end),
    transportEpoch: Number(row.transport_epoch),
    terminalReason: row.terminal_reason,
    createdAt: asIso(row.created_at)!,
    updatedAt: asIso(row.updated_at)!,
  };
}

export class ChatVoiceDeliveryRepository implements VoiceDeliveryPort {
  constructor(readonly kysely: Kysely<ChatDatabase>) {}

  private async requireOwnedChat(executor: Executor, owner: ChatOwner, chatId: string): Promise<void> {
    const chat = await executor.selectFrom("chats").select("id")
      .where("id", "=", chatId)
      .where("owner_type", "=", owner.type)
      .where("owner_id", "=", owner.ownerId)
      .executeTakeFirst();
    if (!chat) throw new ChatNotFoundError(chatId);
  }

  private async selectDelivery(
    executor: Executor,
    chatId: string,
    responseId: string,
    lock = false,
  ) {
    let query = executor.selectFrom("chat_voice_deliveries").selectAll()
      .where("chat_id", "=", chatId)
      .where("response_id", "=", responseId);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }

  private async currentRecord(
    executor: Executor,
    chatId: string,
    responseId: string,
  ): Promise<VoiceDeliveryRecord | null> {
    const row = await this.selectDelivery(executor, chatId, responseId);
    return row ? toVoiceDeliveryRecord(row) : null;
  }

  /**
   * Optimistic-concurrency write: revision/epoch fences live in the WHERE
   * clause and the row is held FOR UPDATE for deterministic classification.
   */
  private fencedUpdate(
    executor: Executor,
    fences: { chatId: string; responseId: string; revision?: number; transportEpoch?: number },
    set: Updateable<ChatVoiceDeliveriesTable>,
  ) {
    let query = executor.updateTable("chat_voice_deliveries").set(set)
      .where("chat_id", "=", fences.chatId)
      .where("response_id", "=", fences.responseId)
      .where("state", "in", [...NON_TERMINAL_STATES]);
    if (fences.revision !== undefined) query = query.where("revision", "=", fences.revision);
    if (fences.transportEpoch !== undefined) {
      query = query.where("transport_epoch", "=", fences.transportEpoch);
    }
    return query.returningAll().executeTakeFirst();
  }

  private assertSameIdentity(
    row: Selectable<ChatVoiceDeliveriesTable>,
    input: VoiceDeliveryPendingInput,
  ): void {
    if (row.run_id !== input.runId
      || row.message_id !== input.messageId
      || !segmentsEqual(readSegments(row), input.segments)) {
      throw new ChatConflictError(input.chatId, Number(row.revision));
    }
  }

  async recordPending(
    ownerInput: ChatOwner,
    rawInput: VoiceDeliveryPendingInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryPendingOutcome>> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const input = RecordPendingInputSchema.parse(rawInput);
    return this.kysely.transaction().execute(async (trx) => {
      await this.requireOwnedChat(trx, owner, input.chatId);
      const inserted = await trx.insertInto("chat_voice_deliveries").values({
        chat_id: input.chatId,
        response_id: input.responseId,
        run_id: input.runId,
        message_id: input.messageId,
        state: "pending",
        revision: 1,
        segments: jsonb(input.segments),
        transport_epoch: input.transportEpoch,
      }).onConflict((conflict) => conflict.columns(["chat_id", "response_id"]).doNothing())
        .returningAll().executeTakeFirst();
      if (inserted) return { outcome: "created", record: toVoiceDeliveryRecord(inserted) };

      const existing = await this.selectDelivery(trx, input.chatId, input.responseId, true);
      if (!existing) throw new ChatNotFoundError(input.chatId);
      this.assertSameIdentity(existing, input);
      let row = existing;
      // Forward-only epoch adoption; stale epochs can never roll the fence back.
      if (input.transportEpoch > Number(existing.transport_epoch)
        && !TERMINAL_STATES.has(existing.state)) {
        const updated = await trx.updateTable("chat_voice_deliveries").set({
          transport_epoch: input.transportEpoch,
          revision: Number(existing.revision) + 1,
          updated_at: new Date(),
        }).where("chat_id", "=", input.chatId)
          .where("response_id", "=", input.responseId)
          .where("transport_epoch", "<", input.transportEpoch)
          .where("state", "in", [...NON_TERMINAL_STATES])
          .returningAll().executeTakeFirst();
        row = updated ?? await this.selectDelivery(trx, input.chatId, input.responseId) ?? row;
      }
      return { outcome: "existing", record: toVoiceDeliveryRecord(row) };
    });
  }

  /**
   * Append later-synthesized segments to a live manifest. The merge happens
   * inside one transaction under the row lock: the combined manifest must stay
   * schema-valid (unique segment ids, non-decreasing canonical text offsets
   * against the existing tail) or the whole write is rejected — a malformed
   * append is a caller bug and throws ChatConflictError rather than persisting
   * a partial manifest. Terminal records absorb the write as `ignored`; a
   * revision/epoch mismatch is `stale`.
   */
  async extendManifest(
    ownerInput: ChatOwner,
    rawInput: VoiceDeliveryExtendInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryExtendOutcome>> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const input = ExtendInputSchema.parse(rawInput);
    return this.kysely.transaction().execute(async (trx) => {
      await this.requireOwnedChat(trx, owner, input.chatId);
      const row = await this.selectDelivery(trx, input.chatId, input.responseId, true);
      if (!row) return { outcome: "not_found", record: null };
      const record = toVoiceDeliveryRecord(row);
      if (TERMINAL_STATES.has(record.state)) return { outcome: "ignored", record };
      if (record.revision !== input.revision || record.transportEpoch !== input.transportEpoch) {
        return { outcome: "stale", record };
      }
      const stored = readSegments(row);
      const merged = stored === null
        ? null
        : VoiceDeliverySegmentsSchema.safeParse([...stored, ...input.appendSegments]);
      if (stored === null || merged === null || !merged.success) {
        // A merge that breaks uniqueness/ordering is a conflict, not an
        // outcome: the record must never hold a manifest that violates the
        // invariants acknowledgements rely on.
        throw new ChatConflictError(input.chatId, record.revision);
      }
      const updated = await this.fencedUpdate(trx, input, {
        segments: jsonb(merged.data),
        revision: record.revision + 1,
        updated_at: new Date(),
      });
      if (updated) return { outcome: "extended", record: toVoiceDeliveryRecord(updated) };
      return { outcome: "stale", record: await this.currentRecord(trx, input.chatId, input.responseId) };
    });
  }

  async acknowledge(
    ownerInput: ChatOwner,
    rawInput: VoiceDeliveryAcknowledgeInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryAcknowledgeOutcome>> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const input = AcknowledgeInputSchema.parse(rawInput);
    return this.kysely.transaction().execute(async (trx) => {
      await this.requireOwnedChat(trx, owner, input.chatId);
      const row = await this.selectDelivery(trx, input.chatId, input.responseId, true);
      if (!row) return { outcome: "not_found", record: null };
      const record = toVoiceDeliveryRecord(row);
      if (TERMINAL_STATES.has(record.state)) return { outcome: "ignored", record };
      if (record.revision !== input.revision || record.transportEpoch !== input.transportEpoch) {
        return { outcome: "stale", record };
      }
      const segments = readSegments(row);
      const index = segments?.findIndex((segment) => segment.segmentId === input.segmentId) ?? -1;
      if (index < 0) return { outcome: "unknown_segment", record };
      const acknowledgedIndex = record.acknowledgedSegment
        ? segments!.findIndex((segment) => segment.segmentId === record.acknowledgedSegment)
        : -1;
      if (index <= acknowledgedIndex) return { outcome: "duplicate", record };
      // Acks must be strictly contiguous: the next acceptable index is
      // acknowledgedIndex + 1. Skipping ahead would let a `complete` claim
      // mark unheard intermediate segments as heard.
      if (index !== acknowledgedIndex + 1) return { outcome: "out_of_order", record };
      // The stored position is the client's claim bounded by the acknowledged
      // segment's cumulative boundary and by delivered audio — it can never
      // credit more than the last whole segment or undelivered playback.
      const cumulativeEndMs = segments!.slice(0, index + 1)
        .reduce((total, segment) => total + segment.durationMs, 0);
      const updated = await this.fencedUpdate(trx, input, {
        state: "playing",
        acknowledged_segment: input.segmentId,
        played_through_ms: Math.max(record.playedThroughMs,
          Math.min(input.playedThroughMs, cumulativeEndMs, record.deliveredThroughMs)),
        effective_text_end: Math.max(record.effectiveTextEnd, segments![index]!.textEnd),
        revision: record.revision + 1,
        updated_at: new Date(),
      });
      if (updated) return { outcome: "acknowledged", record: toVoiceDeliveryRecord(updated) };
      return { outcome: "stale", record: await this.currentRecord(trx, input.chatId, input.responseId) };
    });
  }

  async recordDelivered(
    ownerInput: ChatOwner,
    rawInput: VoiceDeliveryDeliveredInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryDeliveredOutcome>> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const input = DeliveredInputSchema.parse(rawInput);
    return this.kysely.transaction().execute(async (trx) => {
      await this.requireOwnedChat(trx, owner, input.chatId);
      const row = await this.selectDelivery(trx, input.chatId, input.responseId, true);
      if (!row) return { outcome: "not_found", record: null };
      const record = toVoiceDeliveryRecord(row);
      if (TERMINAL_STATES.has(record.state)) return { outcome: "ignored", record };
      if (record.revision !== input.revision || record.transportEpoch !== input.transportEpoch) {
        return { outcome: "stale", record };
      }
      if (input.deliveredThroughMs <= record.deliveredThroughMs) {
        return { outcome: "duplicate", record };
      }
      const updated = await this.fencedUpdate(trx, input, {
        delivered_through_ms: input.deliveredThroughMs,
        revision: record.revision + 1,
        updated_at: new Date(),
      });
      if (updated) return { outcome: "delivered", record: toVoiceDeliveryRecord(updated) };
      return { outcome: "stale", record: await this.currentRecord(trx, input.chatId, input.responseId) };
    });
  }

  async recordTerminal(
    ownerInput: ChatOwner,
    rawInput: VoiceDeliveryTerminalInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryTerminalOutcome>> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const input = TerminalInputSchema.parse(rawInput);
    return this.kysely.transaction().execute(async (trx) => {
      await this.requireOwnedChat(trx, owner, input.chatId);
      const row = await this.selectDelivery(trx, input.chatId, input.responseId, true);
      if (!row) return { outcome: "not_found", record: null };
      const record = toVoiceDeliveryRecord(row);
      if (TERMINAL_STATES.has(record.state)) return { outcome: "ignored", record };
      if (record.revision !== input.revision || record.transportEpoch !== input.transportEpoch) {
        return { outcome: "stale", record };
      }
      if (input.state === "complete") {
        const segments = readSegments(row);
        const acknowledgedIndex = record.acknowledgedSegment && segments
          ? segments.findIndex((segment) => segment.segmentId === record.acknowledgedSegment)
          : -1;
        if (!segments || acknowledgedIndex !== segments.length - 1) {
          return { outcome: "rejected", record };
        }
      }
      const updated = await this.fencedUpdate(trx, input, {
        state: input.state,
        terminal_reason: input.terminalReason ?? input.state,
        revision: record.revision + 1,
        updated_at: new Date(),
      });
      if (updated) return { outcome: "terminal", record: toVoiceDeliveryRecord(updated) };
      return { outcome: "stale", record: await this.currentRecord(trx, input.chatId, input.responseId) };
    });
  }

  /**
   * Crash-window recovery: mark a still non-terminal record `unknown` without
   * requiring the dead epoch's revision/epoch. `unknown` never implies heard.
   */
  async classifyUnknown(
    ownerInput: ChatOwner,
    rawInput: VoiceDeliveryClassifyInput,
  ): Promise<VoiceDeliveryResult<VoiceDeliveryClassifyOutcome>> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const input = ClassifyInputSchema.parse(rawInput);
    return this.kysely.transaction().execute(async (trx) => {
      await this.requireOwnedChat(trx, owner, input.chatId);
      const row = await this.selectDelivery(trx, input.chatId, input.responseId, true);
      if (!row) return { outcome: "not_found", record: null };
      const record = toVoiceDeliveryRecord(row);
      if (TERMINAL_STATES.has(record.state)) return { outcome: "ignored", record };
      const updated = await this.fencedUpdate(trx, { chatId: input.chatId, responseId: input.responseId }, {
        state: "unknown",
        terminal_reason: input.terminalReason ?? "acknowledgement_lost",
        revision: record.revision + 1,
        updated_at: new Date(),
      });
      if (updated) return { outcome: "classified", record: toVoiceDeliveryRecord(updated) };
      return { outcome: "ignored", record: await this.currentRecord(trx, input.chatId, input.responseId) };
    });
  }

  /**
   * Re-fence every open delivery of a chat onto a freshly minted transport
   * epoch after reconnect. One UPDATE moves all non-terminal rows forward
   * (`transport_epoch < :epoch` makes adoption forward-only — a row that
   * already adopted a newer epoch is never rolled back) and bumps each
   * revision so callers re-read the fence (`get`) before their next write.
   * Terminal rows are absorbing and left untouched. Row locks serialize
   * adoption against in-flight fenced writes, so no extra coordination is
   * needed: a stale-epoch writer either commits first (its row is then
   * adopted like the rest) or loses to the adoption fence.
   */
  async adoptTransportEpoch(
    ownerInput: ChatOwner,
    rawInput: VoiceDeliveryAdoptEpochInput,
  ): Promise<{ outcome: "adopted" | "none"; adopted: number }> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const input = AdoptEpochInputSchema.parse(rawInput);
    return this.kysely.transaction().execute(async (trx) => {
      await this.requireOwnedChat(trx, owner, input.chatId);
      const adoptedRows = await trx.updateTable("chat_voice_deliveries").set({
        transport_epoch: input.transportEpoch,
        revision: sql<number>`revision + 1`,
        updated_at: new Date(),
      }).where("chat_id", "=", input.chatId)
        .where("state", "in", [...NON_TERMINAL_STATES])
        .where("transport_epoch", "<", input.transportEpoch)
        .returning("response_id")
        .execute();
      const adopted = adoptedRows.length;
      return adopted > 0 ? { outcome: "adopted", adopted } : { outcome: "none", adopted: 0 };
    });
  }

  async get(
    ownerInput: ChatOwner,
    chatIdInput: string,
    responseIdInput: string,
  ): Promise<VoiceDeliveryRecord | null> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(chatIdInput);
    const responseId = SAFE_REF.parse(responseIdInput);
    const row = await this.kysely.selectFrom("chat_voice_deliveries as delivery")
      .innerJoin("chats as chat", "chat.id", "delivery.chat_id")
      .selectAll("delivery")
      .where("delivery.chat_id", "=", chatId)
      .where("delivery.response_id", "=", responseId)
      .where("chat.owner_type", "=", owner.type)
      .where("chat.owner_id", "=", owner.ownerId)
      .executeTakeFirst();
    return row ? toVoiceDeliveryRecord(row) : null;
  }

  /** responseId → effectiveTextEnd for context building; bounded to 256 rows. */
  async listEffectiveBoundaries(
    ownerInput: ChatOwner,
    chatIdInput: string,
  ): Promise<ReadonlyMap<string, number>> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const chatId = CanonicalChatIdSchema.parse(chatIdInput);
    const rows = await this.kysely.selectFrom("chat_voice_deliveries as delivery")
      .innerJoin("chats as chat", "chat.id", "delivery.chat_id")
      .select(["delivery.response_id", "delivery.effective_text_end"])
      .where("delivery.chat_id", "=", chatId)
      .where("chat.owner_type", "=", owner.type)
      .where("chat.owner_id", "=", owner.ownerId)
      .orderBy("delivery.created_at", "desc")
      .orderBy("delivery.response_id", "desc")
      .limit(MAX_BOUNDARIES)
      .execute();
    return new Map(rows.map((row) => [row.response_id, Number(row.effective_text_end)]));
  }
}
