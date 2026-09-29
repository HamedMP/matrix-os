/**
 * CanonicalVoiceDelivery on real PostgreSQL (MATRIX_TEST_POSTGRES_URL gated):
 * concurrent acknowledgements/terminal writes from separate pooled connections
 * converge on exactly one winner, and a reconnect re-read recovers crash-window
 * records conservatively through the explicit `unknown` classification.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { ChatVoiceDeliveryRepository } from "../../packages/gateway/src/chat/voice-delivery-repository.js";
import {
  createRealCollaborationTestDatabase,
  type CollaborationTestDatabase,
} from "./collaboration-test-support.js";

const owner = { type: "personal" as const, ownerId: "user_voice_delivery_pg_owner" };
const chatId = "chat_voice_delivery_pg";

const manifest = [
  { segmentId: "seg_1", textStart: 0, textEnd: 100, durationMs: 1000 },
  { segmentId: "seg_2", textStart: 100, textEnd: 250, durationMs: 1500 },
];

function pending(responseId = "resp_race") {
  return {
    chatId, responseId, runId: "run_pg", messageId: "msg_pg",
    transportEpoch: 1, segments: [...manifest],
  };
}

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("chat voice delivery on real Postgres", () => {
  let fixture: CollaborationTestDatabase;
  let repository: ChatVoiceDeliveryRepository;

  beforeEach(async () => {
    fixture = await createRealCollaborationTestDatabase();
    await bootstrapChatDatabase(fixture.db);
    await fixture.db.insertInto("chats").values({
      id: chatId,
      owner_type: owner.type,
      owner_id: owner.ownerId,
      create_request_id: "req_voice_delivery_pg",
      title: "Voice delivery races",
      lifecycle: "active",
      attention: "none",
      activity_at: new Date().toISOString(),
    }).execute();
    repository = new ChatVoiceDeliveryRepository(fixture.db);
  });

  afterEach(async () => {
    await fixture.destroy();
  });

  it("converges concurrent acknowledges on one revision winner", async () => {
    await repository.recordPending(owner, pending());
    // Two connections race the same fenced write; exactly one commits.
    const [first, second] = await Promise.all([
      repository.acknowledge(owner, {
        chatId, responseId: "resp_race", segmentId: "seg_1",
        playedThroughMs: 1000, revision: 1, transportEpoch: 1,
      }),
      repository.acknowledge(owner, {
        chatId, responseId: "resp_race", segmentId: "seg_1",
        playedThroughMs: 1000, revision: 1, transportEpoch: 1,
      }),
    ]);
    const outcomes = [first.outcome, second.outcome].sort();
    expect(outcomes).toEqual(["acknowledged", "stale"]);
    const final = await repository.get(owner, chatId, "resp_race");
    expect(final).toMatchObject({
      state: "playing", acknowledgedSegment: "seg_1",
      effectiveTextEnd: 100, revision: 2,
    });
  });

  it("races terminal writes safely: one wins, the loser is ignored", async () => {
    await repository.recordPending(owner, pending());
    const [complete, interrupted] = await Promise.all([
      repository.recordTerminal(owner, {
        chatId, responseId: "resp_race", state: "interrupted",
        terminalReason: "interrupted", revision: 1, transportEpoch: 1,
      }),
      repository.recordTerminal(owner, {
        chatId, responseId: "resp_race", state: "unknown",
        terminalReason: "acknowledgement_lost", revision: 1, transportEpoch: 1,
      }),
    ]);
    const outcomes = [complete.outcome, interrupted.outcome].sort();
    expect(outcomes).toEqual(["ignored", "terminal"]);
    const final = await repository.get(owner, chatId, "resp_race");
    expect(["interrupted", "unknown"]).toContain(final!.state);
    // Neither terminal value can be overwritten or reopened afterwards.
    const after = await repository.recordTerminal(owner, {
      chatId, responseId: "resp_race", state: "interrupted",
      revision: final!.revision, transportEpoch: 1,
    });
    expect(after.outcome).toBe("ignored");
    expect(after.record!.state).toBe(final!.state);
  });

  it("re-read after a transport break yields conservative state recoverable as unknown", async () => {
    await repository.recordPending(owner, pending());
    await repository.recordDelivered(owner, {
      chatId, responseId: "resp_race", deliveredThroughMs: 2500, revision: 1, transportEpoch: 1,
    });
    await repository.acknowledge(owner, {
      chatId, responseId: "resp_race", segmentId: "seg_1",
      playedThroughMs: 1000, revision: 2, transportEpoch: 1,
    });
    // A restarted engine re-reads committed state through a fresh repository.
    const restarted = new ChatVoiceDeliveryRepository(fixture.db);
    const reread = await restarted.get(owner, chatId, "resp_race");
    expect(reread).toMatchObject({ state: "playing", acknowledgedSegment: "seg_1" });
    // The dead epoch cannot write; the explicit classify path recovers.
    const deadEpoch = await restarted.acknowledge(owner, {
      chatId, responseId: "resp_race", segmentId: "seg_2",
      playedThroughMs: 2500, revision: 3, transportEpoch: 2,
    });
    expect(deadEpoch.outcome).toBe("stale");
    const classified = await restarted.classifyUnknown(owner, { chatId, responseId: "resp_race" });
    expect(classified.outcome).toBe("classified");
    expect(classified.record).toMatchObject({
      state: "unknown", effectiveTextEnd: 100, acknowledgedSegment: "seg_1",
    });
  });
});
