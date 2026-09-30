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
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 2, transportEpoch: 1,
    });
    const acked = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 3, transportEpoch: 1,
    });
    expect(acked.outcome).toBe("acknowledged");
    expect(acked.record).toMatchObject({
      state: "playing",
      acknowledgedSegment: "seg_2",
      playedThroughMs: 2500,
      effectiveTextEnd: 250, // never beyond the acknowledged segment's textEnd
      revision: 4,
    });
  });

  it("bounds played_through_ms by the segment boundary and delivered_through_ms", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 2000, revision: 1, transportEpoch: 1,
    });
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 2, transportEpoch: 1,
    });
    // seg_2 cumulative boundary is 2500ms but only 2000ms were delivered.
    const clampedByDelivered = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 99_999, revision: 3, transportEpoch: 1,
    });
    expect(clampedByDelivered.outcome).toBe("acknowledged");
    expect(clampedByDelivered.record!.playedThroughMs).toBe(2000);
    expect(clampedByDelivered.record!.playedThroughMs)
      .toBeLessThanOrEqual(clampedByDelivered.record!.deliveredThroughMs);

    // A conservative client claim below the segment boundary is kept as-is.
    const modest = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_3",
      playedThroughMs: 1800, revision: 4, transportEpoch: 1,
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
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 1, transportEpoch: 1,
    });
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 2, transportEpoch: 1,
    });
    const replay = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 3, transportEpoch: 1,
    });
    expect(replay.outcome).toBe("duplicate");
    expect(replay.record!.revision).toBe(3);

    const earlier = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 3, transportEpoch: 1,
    });
    expect(earlier.outcome).toBe("duplicate");
    expect(earlier.record).toMatchObject({
      acknowledgedSegment: "seg_2", effectiveTextEnd: 250, revision: 3,
    });
  });

  it("rejects an ack that skips unacknowledged predecessors as out_of_order", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordDelivered(owner, {
      chatId, responseId: "resp_1", deliveredThroughMs: 4000, revision: 1, transportEpoch: 1,
    });
    const skipped = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_3",
      playedThroughMs: 4000, revision: 2, transportEpoch: 1,
    });
    expect(skipped.outcome).toBe("out_of_order");
    expect(skipped.record).toMatchObject({
      acknowledgedSegment: null, effectiveTextEnd: 0, playedThroughMs: 0, revision: 2,
    });

    // Even after acknowledging seg_1, jumping straight to seg_3 is rejected.
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 2, transportEpoch: 1,
    });
    const stillSkipped = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_3",
      playedThroughMs: 4000, revision: 3, transportEpoch: 1,
    });
    expect(stillSkipped.outcome).toBe("out_of_order");

    // The contiguous sequence then completes normally.
    const next = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 3, transportEpoch: 1,
    });
    expect(next.outcome).toBe("acknowledged");
    const last = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_3",
      playedThroughMs: 4000, revision: 4, transportEpoch: 1,
    });
    expect(last.outcome).toBe("acknowledged");
    expect(last.record).toMatchObject({
      acknowledgedSegment: "seg_3", effectiveTextEnd: 400,
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
      chatId, responseId: "resp_2", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 1, transportEpoch: 1,
    });
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_2", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 2, transportEpoch: 1,
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

  it("extends the manifest with later segments under the same fences", async () => {
    await repository.recordPending(owner, pendingInput({
      segments: [{ segmentId: "seg_1", textStart: 0, textEnd: 100, durationMs: 1000 }],
    }));
    const extended = await repository.extendManifest(owner, {
      chatId, responseId: "resp_1",
      appendSegments: [
        { segmentId: "seg_2", textStart: 100, textEnd: 250, durationMs: 1500 },
        { segmentId: "seg_3", textStart: 250, textEnd: 400, durationMs: 1500 },
      ],
      revision: 1, transportEpoch: 1,
    });
    expect(extended.outcome).toBe("extended");
    expect(extended.record).toMatchObject({ revision: 2 });
    expect(extended.record!.segments.map((segment) => segment.segmentId))
      .toEqual(["seg_1", "seg_2", "seg_3"]);

    // The merged manifest is acknowledged contiguously and completes.
    for (const [segmentId, revision, playedThroughMs] of [
      ["seg_1", 2, 1000],
      ["seg_2", 3, 2500],
      ["seg_3", 4, 4000],
    ] as const) {
      const acked = await repository.acknowledge(owner, {
        chatId, responseId: "resp_1", segmentId, playedThroughMs, revision, transportEpoch: 1,
      });
      expect(acked.outcome).toBe("acknowledged");
    }
    const completed = await repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "complete", revision: 5, transportEpoch: 1,
    });
    expect(completed.outcome).toBe("terminal");
  });

  it("rejects manifest extension that breaks ordering or id uniqueness", async () => {
    await repository.recordPending(owner, pendingInput());
    // Offsets must not regress below the existing tail's textStart ordering.
    await expect(repository.extendManifest(owner, {
      chatId, responseId: "resp_1",
      appendSegments: [{ segmentId: "seg_9", textStart: 10, textEnd: 500, durationMs: 500 }],
      revision: 1, transportEpoch: 1,
    })).rejects.toThrow(ChatConflictError);
    // Duplicate segment id against the stored manifest.
    await expect(repository.extendManifest(owner, {
      chatId, responseId: "resp_1",
      appendSegments: [{ segmentId: "seg_1", textStart: 400, textEnd: 500, durationMs: 500 }],
      revision: 1, transportEpoch: 1,
    })).rejects.toThrow(ChatConflictError);
    // Empty append lists are rejected at input validation.
    await expect(repository.extendManifest(owner, {
      chatId, responseId: "resp_1",
      appendSegments: [], revision: 1, transportEpoch: 1,
    })).rejects.toThrow();
    const record = await repository.get(owner, chatId, "resp_1");
    expect(record).toMatchObject({ revision: 1 });
    expect(record!.segments).toHaveLength(3);
  });

  it("fences manifest extension by revision and transport epoch", async () => {
    await repository.recordPending(owner, pendingInput());
    const staleRevision = await repository.extendManifest(owner, {
      chatId, responseId: "resp_1",
      appendSegments: [{ segmentId: "seg_4", textStart: 400, textEnd: 500, durationMs: 400 }],
      revision: 9, transportEpoch: 1,
    });
    expect(staleRevision.outcome).toBe("stale");
    const staleEpoch = await repository.extendManifest(owner, {
      chatId, responseId: "resp_1",
      appendSegments: [{ segmentId: "seg_4", textStart: 400, textEnd: 500, durationMs: 400 }],
      revision: 1, transportEpoch: 9,
    });
    expect(staleEpoch.outcome).toBe("stale");
    const missing = await repository.extendManifest(owner, {
      chatId, responseId: "resp_missing",
      appendSegments: [{ segmentId: "seg_4", textStart: 400, textEnd: 500, durationMs: 400 }],
      revision: 1, transportEpoch: 1,
    });
    expect(missing).toMatchObject({ outcome: "not_found", record: null });
  });

  it("absorbs manifest extension on terminal records", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordTerminal(owner, {
      chatId, responseId: "resp_1", state: "interrupted", revision: 1, transportEpoch: 1,
    });
    const extended = await repository.extendManifest(owner, {
      chatId, responseId: "resp_1",
      appendSegments: [{ segmentId: "seg_4", textStart: 400, textEnd: 500, durationMs: 400 }],
      revision: 2, transportEpoch: 1,
    });
    expect(extended.outcome).toBe("ignored");
    expect(extended.record).toMatchObject({ state: "interrupted", revision: 2 });
    expect(extended.record!.segments).toHaveLength(3);
  });

  it("adopts a new transport epoch across every open row and bumps revisions", async () => {
    await repository.recordPending(owner, pendingInput());
    await repository.recordPending(owner, pendingInput({ responseId: "resp_2" }));
    // A terminal row must never be touched by adoption.
    await repository.recordPending(owner, pendingInput({ responseId: "resp_3" }));
    await repository.recordTerminal(owner, {
      chatId, responseId: "resp_3", state: "interrupted", revision: 1, transportEpoch: 1,
    });

    const adopted = await repository.adoptTransportEpoch(owner, { chatId, transportEpoch: 7 });
    expect(adopted).toEqual({ outcome: "adopted", adopted: 2 });

    const first = await repository.get(owner, chatId, "resp_1");
    const second = await repository.get(owner, chatId, "resp_2");
    const terminal = await repository.get(owner, chatId, "resp_3");
    expect(first).toMatchObject({ transportEpoch: 7, revision: 2, state: "pending" });
    expect(second).toMatchObject({ transportEpoch: 7, revision: 2 });
    expect(terminal).toMatchObject({ transportEpoch: 1, revision: 2, state: "interrupted" });

    // Old-epoch writes lose the fence after adoption.
    const staleWrite = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 1, transportEpoch: 1,
    });
    expect(staleWrite.outcome).toBe("stale");
    const newEpoch = await repository.acknowledge(owner, {
      chatId, responseId: "resp_1", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 2, transportEpoch: 7,
    });
    expect(newEpoch.outcome).toBe("acknowledged");

    // Re-adopting the same or an older epoch is a no-op; adoption is forward-only.
    const again = await repository.adoptTransportEpoch(owner, { chatId, transportEpoch: 7 });
    expect(again).toEqual({ outcome: "none", adopted: 0 });
  });

  it("adopts epochs only for the owning chat and owner", async () => {
    await repository.recordPending(owner, pendingInput());
    await expect(repository.adoptTransportEpoch(outsider, { chatId, transportEpoch: 2 }))
      .rejects.toThrow("Chat not found");
    const record = await repository.get(owner, chatId, "resp_1");
    expect(record).toMatchObject({ transportEpoch: 1, revision: 1 });
  });
});
