import { describe, expect, it } from "vitest";
import {
  applyCanonicalChatContent,
  mergeCanonicalChatListRecord,
  preferCanonicalChatDetailSnapshot,
  type CanonicalChatDetailResponse,
  type CanonicalChatListResponse,
  type CanonicalChatMessage,
} from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

const initial: CanonicalChatDetailResponse = {
  record: { chat: {
    id: "chat_content", ownerScope: { type: "personal", ownerId: "owner_test" },
    title: "Content", lifecycle: "active", attention: "none", revision: 1, messageCount: 0,
    createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z",
  } }, messages: [], turns: [], runs: [], activities: [],
};
const message: CanonicalChatMessage = {
  id: "msg_stream", chatId: "chat_content", seq: 1, role: "assistant", state: "pending",
  parts: [{ type: "text", text: "hello" }], createdAt: "2026-09-06T00:00:00.000Z",
};
function frame(revision: number, offset: number, text: string) {
  return {
    type: "chat.content" as const,
    event: { cursor: revision, revision, chatId: "chat_content", eventType: "run.message" as const,
      createdAt: "2026-09-06T00:00:00.000Z" },
    content: { record: { ...initial.record, chat: { ...initial.record.chat, revision, messageCount: 1 } },
      messageDelta: { message: { ...message, parts: [{ type: "text" as const, text }] }, partIndex: 0, offset },
    },
  };
}
describe("canonical Chat content reducer", () => {
  it("slides a full projection window instead of forcing a snapshot for every new item", () => {
    const full = { ...initial,
      runs: [{ ...createCanonicalChatFixture("running").snapshot.runs[0]!, id: "run_test", chatId: "chat_content" }],
      messages: Array.from({ length: 200 }, (_, i) => ({ ...message, id: `msg_${i}`, seq: i + 1, runId: "run_test" })),
      activities: Array.from({ length: 500 }, (_, i) => ({ id: `activity_${i}`, chatId: "chat_content",
        runId: "run_test", type: "run.status" as const, status: "running" as const,
        occurredAt: initial.record.chat.createdAt, sequence: i + 1 })),
    };
    const update = frame(2, 0, "next");
    update.content.messageDelta.message.seq = 201;
    const next = applyCanonicalChatContent(full, { ...update, content: { ...update.content,
      activities: [{ ...full.activities[0]!, id: "activity_next", sequence: 501 }],
    } })!;
    expect(next).not.toBeNull();
    expect(next.messages).toHaveLength(200);
    expect(next.messages[0]?.seq).toBe(2);
    expect(next.nextBeforeSeq).toBe(2);
    expect(next.activities).toHaveLength(500);
    expect(next.activities.at(-1)?.id).toBe("activity_next");
    expect(full.messages[0]?.seq).toBe(1);
  });
  it("removes activities whose last associated message leaves the visible window", () => {
    const full = { ...initial,
      runs: ["run_old", "run_test"].map((id) => ({ ...createCanonicalChatFixture("running").snapshot.runs[0]!, id, chatId: "chat_content" })),
      messages: Array.from({ length: 200 }, (_, i) => ({ ...message, id: `msg_${i}`, seq: i + 1,
        runId: i === 0 ? "run_old" : "run_test" })),
      activities: [{ id: "activity_old", chatId: "chat_content", runId: "run_old",
        type: "run.status" as const, status: "failed" as const, occurredAt: initial.record.chat.createdAt }],
    };
    const update = frame(2, 0, "next");
    update.content.messageDelta.message.seq = 201;
    expect(applyCanonicalChatContent(full, update)?.activities).toEqual([]);
  });
  it("applies and deduplicates streamed text without a snapshot request or mutating existing state", () => {
    const first = applyCanonicalChatContent(initial, frame(2, 0, "hello"))!;
    const second = applyCanonicalChatContent(first, frame(3, 5, " world"))!;
    expect(second.messages[0]?.parts).toEqual([{ type: "text", text: "hello world" }]);
    expect(first.messages[0]?.parts).toEqual([{ type: "text", text: "hello" }]);
    expect(initial.messages).toEqual([]);
    expect(applyCanonicalChatContent(second, frame(3, 5, " world"))).toBe(second);
  });
  it("requests recovery for missing content instead of silently producing a broken transcript", () => {
    expect(applyCanonicalChatContent(initial, frame(3, 5, " world"))).toBeNull();
  });
  it("ignores another Chat and snapshots already newer than a replayed event", () => {
    expect(applyCanonicalChatContent(initial, { ...frame(2, 0, "hello"), event: {
      ...frame(2, 0, "hello").event, chatId: "chat_other",
    } })).toBe(initial);
    expect(applyCanonicalChatContent(initial, frame(1, 0, "old"))).toBe(initial);
  });

  it("upserts list records without rolling a newer streamed revision backward", () => {
    const list: CanonicalChatListResponse = { items: [initial.record] };
    const newer = { ...initial.record, chat: { ...initial.record.chat, revision: 3, title: "Newer" } };
    const streamed = mergeCanonicalChatListRecord(list, newer);

    expect(streamed.items).toEqual([newer]);
    expect(mergeCanonicalChatListRecord(streamed, initial.record)).toBe(streamed);
  });

  it("fences a stale REST detail snapshot behind streamed state", () => {
    const streamed = { ...initial, record: {
      ...initial.record,
      chat: { ...initial.record.chat, revision: 4, title: "Streamed" },
    } };

    expect(preferCanonicalChatDetailSnapshot(streamed, initial, 4)).toBe(streamed);
    expect(preferCanonicalChatDetailSnapshot(undefined, initial, 4)).toBeUndefined();
    expect(preferCanonicalChatDetailSnapshot(streamed, {
      ...initial,
      record: { ...initial.record, chat: { ...initial.record.chat, revision: 5 } },
    }, 4)?.record.chat.revision).toBe(5);
  });
});
