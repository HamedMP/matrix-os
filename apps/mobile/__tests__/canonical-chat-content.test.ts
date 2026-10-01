import type {
  CanonicalChatContentFrame,
  CanonicalChatDetailResponse,
  CanonicalChatMessage,
} from "@matrix-os/contracts";

import { applyCanonicalChatContent, applyCanonicalChatContentFrames } from "../lib/canonical-chat-content";

const createdAt = "2026-09-06T00:00:00.000Z";

const initial: CanonicalChatDetailResponse = {
  record: { chat: {
    id: "chat_content", ownerScope: { type: "personal", ownerId: "owner_test" },
    title: "Content", lifecycle: "active", attention: "none", revision: 1, messageCount: 0,
    createdAt, updatedAt: createdAt,
  } },
  messages: [], turns: [], runs: [], activities: [],
};

const message: CanonicalChatMessage = {
  id: "msg_stream", chatId: "chat_content", seq: 1, role: "assistant", state: "pending",
  parts: [{ type: "text", text: "hello" }], createdAt,
};

function frame(revision: number, content: Partial<CanonicalChatContentFrame["content"]>): CanonicalChatContentFrame {
  return {
    type: "chat.content",
    event: { cursor: revision, revision, chatId: "chat_content", eventType: "run.message", createdAt },
    content: { record: { chat: { ...initial.record.chat, revision } }, ...content },
  };
}

function textDelta(revision: number, offset: number, text: string): CanonicalChatContentFrame {
  return frame(revision, {
    messageDelta: { message: { ...message, parts: [{ type: "text", text }] }, partIndex: 0, offset },
  });
}

describe("applyCanonicalChatContent", () => {
  it("appends streamed text deltas without mutating the previous detail", () => {
    const first = applyCanonicalChatContent(initial, textDelta(2, 0, "hello"))!;
    const second = applyCanonicalChatContent(first, textDelta(3, 5, " world"))!;

    expect(second.messages[0]?.parts).toEqual([{ type: "text", text: "hello world" }]);
    expect(second.record.chat.revision).toBe(3);
    expect(first.messages[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(initial.messages).toEqual([]);
  });

  it("ignores frames the detail already reflects", () => {
    const applied = applyCanonicalChatContent(initial, textDelta(2, 0, "hello"))!;

    expect(applyCanonicalChatContent(applied, textDelta(2, 0, "hello"))).toBe(applied);
    expect(applyCanonicalChatContent(initial, {
      ...textDelta(2, 0, "hello"),
      event: { ...textDelta(2, 0, "hello").event, chatId: "chat_other" },
    })).toBe(initial);
  });

  it("returns null when a frame was missed, so the caller refetches a snapshot", () => {
    expect(applyCanonicalChatContent(initial, textDelta(3, 5, " world"))).toBeNull();
  });

  it("returns null when a delta does not continue the text already held", () => {
    const applied = applyCanonicalChatContent(initial, textDelta(2, 0, "hello"))!;

    expect(applyCanonicalChatContent(applied, textDelta(3, 9, " world"))).toBeNull();
  });

  it("upserts whole entities and drops removed activities", () => {
    const stale = {
      id: "activity_stale", chatId: "chat_content", runId: "run_test",
      type: "run.status" as const, status: "running" as const, occurredAt: createdAt,
    };
    const fresh = { ...stale, id: "activity_fresh" };
    const committed: CanonicalChatMessage = { ...message, state: "committed" };

    const next = applyCanonicalChatContent(
      { ...initial, messages: [message], activities: [stale] },
      frame(2, { messages: [committed], activities: [fresh], removedActivityIds: ["activity_stale"] }),
    )!;

    expect(next.messages).toEqual([committed]);
    expect(next.activities).toEqual([fresh]);
  });
});

describe("applyCanonicalChatContentFrames", () => {
  it("applies frames in order and keeps the ones that need a newer snapshot", () => {
    const missed = textDelta(4, 11, "!");
    const result = applyCanonicalChatContentFrames(initial, [
      textDelta(2, 0, "hello"),
      missed,
    ]);

    expect(result.detail.messages[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(result.unapplied).toEqual([missed]);
  });

  it("skips frames a fresh snapshot already contains and continues from there", () => {
    const snapshot = applyCanonicalChatContentFrames(initial, [
      textDelta(2, 0, "hello"),
      textDelta(3, 5, " world"),
    ]).detail;

    const result = applyCanonicalChatContentFrames(snapshot, [
      textDelta(3, 5, " world"),
      textDelta(4, 11, "!"),
    ]);

    expect(result.detail.messages[0]?.parts).toEqual([{ type: "text", text: "hello world!" }]);
    expect(result.unapplied).toEqual([]);
  });
});
