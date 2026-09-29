/**
 * CanonicalVoiceDelivery repository (specs/535-aoede-rewrite, FR-034A) on
 * PGlite: idempotent pending registration, revision/epoch-fenced
 * acknowledgements bounded by whole segments, monotonic delivery, absorbing
 * terminal states, and the explicit crash-window `unknown` classification.
 */
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase, type ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatConflictError } from "../../packages/gateway/src/chat/errors.js";
import {
  ChatVoiceDeliveryRepository,
  type VoiceDeliveryPendingInput,
} from "../../packages/gateway/src/chat/voice-delivery-repository.js";

const owner = { type: "personal" as const, ownerId: "user_voice_delivery_owner" };
const outsider = { type: "personal" as const, ownerId: "user_voice_delivery_outsider" };
const chatId = "chat_voice_delivery_main";

const manifest = [
  { segmentId: "seg_1", textStart: 0, textEnd: 100, durationMs: 1000 },
  { segmentId: "seg_2", textStart: 100, textEnd: 250, durationMs: 1500 },
  { segmentId: "seg_3", textStart: 250, textEnd: 400, durationMs: 1500 },
] as const;
// Cumulative segment ends: seg_1 → 1000ms, seg_2 → 2500ms, seg_3 → 4000ms.

function pendingInput(overrides: Partial<VoiceDeliveryPendingInput> = {}): VoiceDeliveryPendingInput {
  return {
    chatId,
    responseId: "resp_1",
    runId: "run_1",
    messageId: "msg_1",
    transportEpoch: 1,
    segments: [...manifest],
    ...overrides,
  };
}

describe("chat voice delivery repository", () => {
  let pglite: InstanceType<typeof KyselyPGlite>;
  let db: Kysely<ChatDatabase>;
  let repository: ChatVoiceDeliveryRepository;

  beforeEach(async () => {
    pglite = await KyselyPGlite.create();
    db = new Kysely<ChatDatabase>({ dialect: pglite.dialect });
    await bootstrapChatDatabase(db);
    await db.insertInto("chats").values({
      id: chatId,
      owner_type: owner.type,
      owner_id: owner.ownerId,
      create_request_id: "req_voice_delivery_chat",
      title: "Voice delivery",
      lifecycle: "active",
      attention: "none",
      activity_at: new Date().toISOString(),
    }).execute();
    repository = new ChatVoiceDeliveryRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("inserts pending before first playback and re-registers idempotently", async () => {
    const created = await repository.recordPending(owner, pendingInput());
    expect(created.outcome).toBe("created");
    expect(created.record).toMatchObject({
      chatId,
      responseId: "resp_1",
      runId: "run_1",
      messageId: "msg_1",
      state: "pending",
      revision: 1,
      acknowledgedSegment: null,
      deliveredThroughMs: 0,
      playedThroughMs: 0,
      effectiveTextEnd: 0,
      transportEpoch: 1,
      terminalReason: null,
    });
    expect(created.record!.segments).toEqual([...manifest]);

    const again = await repository.recordPending(owner, pendingInput());
    expect(again.outcome).toBe("existing");
    expect(again.record).toMatchObject({ state: "pending", revision: 1, transportEpoch: 1 });
  });

  it("rejects a conflicting immutable identity", async () => {
    await repository.recordPending(owner, pendingInput());
    await expect(repository.recordPending(owner, pendingInput({ messageId: "msg_other" })))
      .rejects.toThrow(ChatConflictError);
    await expect(repository.recordPending(owner, pendingInput({ runId: "run_other" })))
      .rejects.toThrow(ChatConflictError);
    await expect(repository.recordPending(owner, pendingInput({
      segments: [{ segmentId: "seg_1", textStart: 0, textEnd: 100, durationMs: 999 }],
    }))).rejects.toThrow(ChatConflictError);
  });

  it("adopts a newer transport epoch on identical re-registration but never rolls back", async () => {
    await repository.recordPending(owner, pendingInput());
    const adopted = await repository.recordPending(owner, pendingInput({ transportEpoch: 2 }));
    expect(adopted.outcome).toBe("existing");
    expect(adopted.record).toMatchObject({ transportEpoch: 2, revision: 2 });

    const staleRetry = await repository.recordPending(owner, pendingInput({ transportEpoch: 1 }));
    expect(staleRetry.record).toMatchObject({ transportEpoch: 2, revision: 2 });
  });

  it("acknowledges a segment to its exact boundary and flips pending to playing", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 5000, revision: 1, transportEpoch: 1,
    });
    const acked = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 2, transportEpoch: 1,
    });
    expect(acked.outcome).toBe("acknowledged");
    expect(acked.record).toMatchObject({
      state: "playing",
      acknowledgedSegment: "seg_2",
      playedThroughMs: 2500,
      effectiveTextEnd: 250, // never beyond the acknowledged segment's textEnd
      revision: 3,
    });
  });

  it("bounds played_through_ms by the segment boundary and delivered_through_ms", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 2000, revision: 1, transportEpoch: 1,
    });
    // seg_2 cumulative boundary is 2500ms but only 2000ms were delivered.
    const clampedByDelivered = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 99_999, revision: 2, transportEpoch: 1,
    });
    expect(clampedByDelivered.outcome).toBe("acknowledged");
    expect(clampedByDelivered.record!.playedThroughMs).toBe(2000);
    expect(clampedByDelivered.record!.playedThroughMs)
      .toBeLessThanOrEqual(clampedByDelivered.record!.deliveredThroughMs);

    // A conservative client claim below the segment boundary is kept as-is.
    const modest = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_3",
      playedThroughMs: 1800, revision: 3, transportEpoch: 1,
    });
    expect(modest.outcome).toBe("acknowledged");
    expect(modest.record!.playedThroughMs).toBe(2000); // never regresses
    expect(modest.record!.effectiveTextEnd).toBe(400);
  });

  it("rejects unknown segments and stale fences without mutation", async () => {
    await repository.recordPending(owner, pendingInput());
    const unknown = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_nope",
      playedThroughMs: 0, revision: 1, transportEpoch: 1,
    });
    expect(unknown.outcome).toBe("unknown_segment");

    const staleRevision = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 0, revision: 99, transportEpoch: 1,
    });
    expect(staleRevision.outcome).toBe("stale");

    const staleEpoch = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 0, revision: 1, transportEpoch: 7,
    });
    expect(staleEpoch.outcome).toBe("stale");

    const record = await repository.get(owner, chatId, "resp_1");
    expect(record).toMatchObject({
      state: "pending", revision: 1, acknowledgedSegment: null, effectiveTextEnd: 0,
    });
  });

  it("treats replayed acks of the same or an earlier segment as no-op success", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 1, transportEpoch: 1,
    });
    const replay = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 2, transportEpoch: 1,
    });
    expect(replay.outcome).toBe("duplicate");
    expect(replay.record!.revision).toBe(2);

    const earlier = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 2, transportEpoch: 1,
    });
    expect(earlier.outcome).toBe("duplicate");
    expect(earlier.record).toMatchObject({
      acknowledgedSegment: "seg_2", effectiveTextEnd: 250, revision: 2,
    });
  });

  it("lets an ack skip ahead to a later ordered segment", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 4000, revision: 1, transportEpoch: 1,
    });
    const skipped = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_3",
      playedThroughMs: 4000, revision: 2, transportEpoch: 1,
    });
    expect(skipped.outcome).toBe("acknowledged");
    expect(skipped.record).toMatchObject({
      acknowledgedSegment: "seg_3", effectiveTextEnd: 400, playedThroughMs: 4000,
    });
  });

  it("advances delivered_through_ms monotonically under the same fences", async () => {
    await repository.recordPending(owner, pendingInput());
    const delivered = await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 5000, revision: 1, transportEpoch: 1,
    });
    expect(delivered.outcome).toBe("delivered");
    expect(delivered.record).toMatchObject({ deliveredThroughMs: 5000, revision: 2, state: "pending" });

    const regressed = await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 3000, revision: 2, transportEpoch: 1,
    });
    expect(regressed.outcome).toBe("duplicate");
    expect(regressed.record!.deliveredThroughMs).toBe(5000);

    const staleEpoch = await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 9000, revision: 2, transportEpoch: 8,
    });
    expect(staleEpoch.outcome).toBe("stale");
  });

  it("rejects complete while any segment is unacknowledged, then accepts it fully acked", async () => {
    await repository.recordPending(owner, pendingInput());
    const premature = await repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "complete", revision: 1, transportEpoch: 1,
    });
    expect(premature.outcome).toBe("rejected");
    expect(premature.record!.state).toBe("pending");

    // Partial acks still cannot justify complete.
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 1, transportEpoch: 1,
    });
    const stillPartial = await repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "complete", revision: 2, transportEpoch: 1,
    });
    expect(stillPartial.outcome).toBe("rejected");

    for (const [segmentId, revision, playedThroughMs] of [
      ["seg_2", 2, 2500],
      ["seg_3", 3, 4000],
    ] as const) {
      const acked = await repository.acknowledge(owner, {
        chatId, responseId: "resp_1", segmentId, playedThroughMs, revision, transportEpoch: 1,
      });
      expect(acked.outcome).toBe("acknowledged");
    }
    const completed = await repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "complete",
      terminalReason: "complete", revision: 4, transportEpoch: 1,
    });
    expect(completed.outcome).toBe("terminal");
    expect(completed.record).toMatchObject({
      state: "complete", terminalReason: "complete", revision: 5, effectiveTextEnd: 400,
    });
  });

  it("makes terminal states absorbing: no reopen, no overwrite, writes return ignored", async () => {
    await repository.recordPending(owner, pendingInput());
    const terminal = await repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "interrupted",
      terminalReason: "interrupted", revision: 1, transportEpoch: 1,
    });
    expect(terminal.outcome).toBe("terminal");

    const overwrite = await repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "unknown",
      terminalReason: "acknowledgement_lost", revision: 2, transportEpoch: 1,
    });
    expect(overwrite.outcome).toBe("ignored");
    expect(overwrite.record).toMatchObject({ state: "interrupted", terminalReason: "interrupted" });

    const lateAck = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 2, transportEpoch: 1,
    });
    expect(lateAck.outcome).toBe("ignored");
    const lateDelivered = await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 9000, revision: 2, transportEpoch: 1,
    });
    expect(lateDelivered.outcome).toBe("ignored");
    const reRegister = await repository.recordPending(owner, pendingInput({ transportEpoch: 9 }));
    expect(reRegister.record).toMatchObject({ state: "interrupted", transportEpoch: 1 });
    expect((await repository.get(owner, chatId, "resp_1"))!.state).toBe("interrupted");
  });

  it("classifies a crash-window record unknown and keeps it terminal", async () => {
    await repository.recordPending(owner, pendingInput());
    const crashed = await repository.classifyUnknown(owner, { chatId, responseId: "resp_1" });
    expect(crashed.outcome).toBe("classified");
    expect(crashed.record).toMatchObject({
      state: "unknown", terminalReason: "acknowledgement_lost", revision: 2,
    });

    // Playing record with a partial ack trail also recovers as unknown.
    await repository.recordPending(owner, pendingInput({ responseId: "resp_2" }));
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_2", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 1, transportEpoch: 1,
    });
    const recovered = await repository.classifyUnknown(owner, {
      chatId, responseId: "resp_2", terminalReason: "crashed",
    });
    expect(recovered.outcome).toBe("classified");
    expect(recovered.record).toMatchObject({
      state: "unknown", terminalReason: "crashed", acknowledgedSegment: "seg_1",
      effectiveTextEnd: 100,
    });

    const again = await repository.classifyUnknown(owner, { chatId, responseId: "resp_1" });
    expect(again.outcome).toBe("ignored");
    expect(again.record!.state).toBe("unknown");
    expect(await repository.classifyUnknown(owner, { chatId, responseId: "resp_missing" }))
      .toMatchObject({ outcome: "not_found", record: null });
  });

  it("scopes reads to the owner and projects effective boundaries per chat", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordPending(owner, pendingInput({ responseId: "resp_2" }));
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_2", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 1, transportEpoch: 1,
    });

    expect(await repository.get(outsider, chatId, "resp_1")).toBeNull();
    expect(await repository.get(owner, chatId, "resp_missing")).toBeNull();

    const boundaries = await repository.listEffectiveBoundaries(owner, chatId);
    expect(boundaries.get("resp_1")).toBe(0);
    expect(boundaries.get("resp_2")).toBe(250);
    expect(await repository.listEffectiveBoundaries(outsider, chatId)).toEqual(new Map());
  });

  it("requires the chat to belong to the owner for writes", async () => {
    await expect(repository.recordPending(outsider, pendingInput())).rejects.toThrow("Chat not found");
    await expect(repository.acknowledge(outsider, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 0, revision: 1, transportEpoch: 1,
    })).rejects.toThrow("Chat not found");
  });

  it("validates public inputs", async () => {
    await expect(repository.recordPending(
      { type: "bogus", ownerId: "x" } as never, pendingInput(),
    )).rejects.toThrow();
    await expect(repository.recordPending(owner, pendingInput({ chatId: "not-a-chat" })))
      .rejects.toThrow();
    await expect(repository.recordPending(owner, pendingInput({ segments: [] })))
      .rejects.toThrow();
    await expect(repository.recordPending(owner, pendingInput({
      segments: [
        { segmentId: "seg_1", textStart: 100, textEnd: 50, durationMs: 1 },
      ],
    }))).rejects.toThrow();
    await expect(repository.recordPending(owner, pendingInput({
      segments: [
        { segmentId: "seg_2", textStart: 50, textEnd: 100, durationMs: 1 },
        { segmentId: "seg_1", textStart: 0, textEnd: 50, durationMs: 1 },
      ],
    }))).rejects.toThrow();
    await expect(repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: -1, revision: 1, transportEpoch: 1,
    })).rejects.toThrow();
    await expect(repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "playing" as never, revision: 1, transportEpoch: 1,
    })).rejects.toThrow();
  });
});
