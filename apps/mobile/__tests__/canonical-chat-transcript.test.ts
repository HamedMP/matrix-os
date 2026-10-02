import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";

import {
  isOptimisticMessageDelivered,
  latestMessageSeq,
  optimisticTranscriptMessage,
  type OptimisticUserMessage,
} from "../lib/canonical-chat-transcript";

// The contracts barrel pulls in ESM-only micromark, which Jest cannot load.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

function userMessage(id: string, seq: number, text: string) {
  return {
    id,
    chatId: "chat_1",
    role: "user",
    state: "committed",
    seq,
    parts: [{ type: "text", text }],
    createdAt: "2026-09-09T00:00:00.000Z",
  };
}

function detailWith(messages: ReturnType<typeof userMessage>[], chatId = "chat_1") {
  return {
    record: { chat: { id: chatId } },
    runs: [],
    turns: [],
    activities: [],
    messages,
  } as unknown as CanonicalChatDetailResponse;
}

const optimistic: OptimisticUserMessage = {
  id: "optimistic-req_1",
  chatId: "chat_1",
  text: "Ship it",
  afterSeq: 2,
  createdAt: 1_700_000_000_000,
};

describe("optimistic user messages", () => {
  it("reads the highest message seq, or 0 before the chat has any", () => {
    expect(latestMessageSeq(null)).toBe(0);
    expect(latestMessageSeq(detailWith([]))).toBe(0);
    expect(latestMessageSeq(detailWith([userMessage("msg_b", 7, "b"), userMessage("msg_a", 3, "a")]))).toBe(7);
  });

  it("renders as an ordinary sent user message", () => {
    expect(optimisticTranscriptMessage(optimistic)).toEqual({
      id: "optimistic-req_1",
      role: "user",
      text: "Ship it",
      toolCalls: [],
      activities: [],
      isRunning: false,
      createdAt: 1_700_000_000_000,
    });
  });

  it("is undelivered until the chat's detail holds the server's copy", () => {
    expect(isOptimisticMessageDelivered(null, optimistic)).toBe(false);
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_1", 1, "Hello")]), optimistic)).toBe(false);
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_3", 3, "Ship it")]), optimistic)).toBe(true);
  });

  it("does not mistake an earlier message with the same text for the new one", () => {
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_2", 2, "Ship it")]), optimistic)).toBe(false);
  });

  it("matches the admitted message by id even if the stored text differs", () => {
    const admitted = { ...optimistic, messageId: "msg_3" };
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_3", 3, "Ship it!")]), admitted)).toBe(true);
  });

  it("ignores another chat's detail", () => {
    const other = detailWith([userMessage("msg_3", 3, "Ship it")], "chat_other");
    expect(isOptimisticMessageDelivered(other, optimistic)).toBe(false);
  });
});
