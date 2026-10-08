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

function run(id: string) {
  return {
    id, chatId: "chat_content", turnId: "cturn_test", status: "running", createdAt, updatedAt: createdAt,
  } as unknown as CanonicalChatDetailResponse["runs"][number];
}

function activity(id: string, runId: string) {
  return {
    id, chatId: "chat_content", runId, type: "run.status" as const, status: "running" as const, occurredAt: createdAt,
  };
}

/** The delta that starts message 201, pushing the oldest one out of a full window. */
const newestMessage = {
  ...message, id: "msg_newest", seq: 201, runId: "run_test", parts: [{ type: "text" as const, text: "next" }],
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
    const stale = activity("activity_stale", "run_test");
    const fresh = activity("activity_fresh", "run_test");
    const pending: CanonicalChatMessage = { ...message, runId: "run_test" };
    const committed: CanonicalChatMessage = { ...pending, state: "committed" };

    const next = applyCanonicalChatContent(
      { ...initial, messages: [pending], runs: [run("run_test")], activities: [stale] },
      frame(2, { messages: [committed], activities: [fresh], removedActivityIds: ["activity_stale"] }),
    )!;

    expect(next.messages).toEqual([committed]);
    expect(next.activities).toEqual([fresh]);
  });

  it("keeps the newest 200 messages and 500 activities, like a snapshot, instead of growing", () => {
    const full: CanonicalChatDetailResponse = {
      ...initial,
      runs: [run("run_test")],
      messages: Array.from({ length: 200 }, (_, i) => ({ ...message, id: `msg_${i}`, seq: i + 1, runId: "run_test" })),
      activities: Array.from({ length: 500 }, (_, i) => ({ ...activity(`activity_${i}`, "run_test"), sequence: i + 1 })),
    };
    const update = frame(2, {
      messageDelta: { message: newestMessage, partIndex: 0, offset: 0 },
      activities: [{ ...activity("activity_next", "run_test"), sequence: 501 }],
    });

    const next = applyCanonicalChatContent(full, update)!;

    expect(next.messages).toHaveLength(200);
    expect(next.messages[0]?.seq).toBe(2);
    expect(next.activities).toHaveLength(500);
    expect(next.activities.at(-1)?.id).toBe("activity_next");
    expect(full.messages[0]?.seq).toBe(1);
  });

  it("keeps a run that has no reply yet, through the turn of the message that asked for it", () => {
    const question: CanonicalChatMessage = {
      id: "msg_question", chatId: "chat_content", seq: 1, role: "user", state: "committed",
      turnId: "cturn_test", parts: [{ type: "text", text: "hi" }], createdAt,
    };
    const turn = {
      id: "cturn_test", chatId: "chat_content", inputMessageId: "msg_question", createdAt,
    } as unknown as CanonicalChatDetailResponse["turns"][number];
    const thinking = activity("activity_thinking", "run_test");

    const next = applyCanonicalChatContent(
      { ...initial, messages: [question], turns: [turn], runs: [run("run_test")] },
      frame(2, { activities: [thinking] }),
    )!;

    expect(next.runs.map((item) => item.id)).toEqual(["run_test"]);
    expect(next.activities).toEqual([thinking]);
  });

  it("drops runs and activities once their last message has left the window", () => {
    const full: CanonicalChatDetailResponse = {
      ...initial,
      runs: [run("run_old"), run("run_test")],
      messages: Array.from({ length: 200 }, (_, i) => ({
        ...message, id: `msg_${i}`, seq: i + 1, runId: i === 0 ? "run_old" : "run_test",
      })),
      activities: [activity("activity_old", "run_old")],
    };
    const update = frame(2, {
      messageDelta: { message: newestMessage, partIndex: 0, offset: 0 },
    });

    const next = applyCanonicalChatContent(full, update)!;

    expect(next.runs.map((item) => item.id)).toEqual(["run_test"]);
    expect(next.activities).toEqual([]);
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
