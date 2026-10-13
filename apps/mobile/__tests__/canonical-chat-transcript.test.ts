import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";

import {
  buildTranscript,
  isOptimisticMessageDelivered,
  optimisticTranscriptMessage,
  withLocalAttachments,
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

function turn(clientRequestId: string, inputMessageId: string) {
  return { id: `cturn_${inputMessageId}`, chatId: "chat_1", clientRequestId, inputMessageId };
}

function detailWith(
  messages: ReturnType<typeof userMessage>[],
  turns: ReturnType<typeof turn>[] = [],
  chatId = "chat_1",
) {
  return {
    record: { chat: { id: chatId } },
    runs: [],
    turns,
    activities: [],
    messages,
  } as unknown as CanonicalChatDetailResponse;
}

const optimistic: OptimisticUserMessage = {
  id: "optimistic-req_mine",
  chatId: "chat_1",
  text: "Ship it",
  turnRequestId: "req_mine",
  createdAt: 1_700_000_000_000,
};

describe("optimistic user messages", () => {
  it("renders as an ordinary sent user message", () => {
    expect(optimisticTranscriptMessage(optimistic)).toEqual({
      id: "optimistic-req_mine",
      role: "user",
      text: "Ship it",
      toolCalls: [],
      activities: [],
      isRunning: false,
      createdAt: 1_700_000_000_000,
    });
  });

  it("is delivered once the detail holds the message of the turn admitted for this send", () => {
    expect(isOptimisticMessageDelivered(null, optimistic)).toBe(false);
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_1", 1, "Hello")]), optimistic)).toBe(false);
    expect(isOptimisticMessageDelivered(
      detailWith([userMessage("msg_3", 3, "Ship it")], [turn("req_mine", "msg_3")]),
      optimistic,
    )).toBe(true);
  });

  it("is not delivered by the same text sent by another client or participant", () => {
    const detail = detailWith([userMessage("msg_3", 3, "Ship it")], [turn("req_theirs", "msg_3")]);
    expect(isOptimisticMessageDelivered(detail, optimistic)).toBe(false);
  });

  it("waits for the turn's message, not just the turn", () => {
    const detail = detailWith([userMessage("msg_1", 1, "Hello")], [turn("req_mine", "msg_3")]);
    expect(isOptimisticMessageDelivered(detail, optimistic)).toBe(false);
  });

  it("falls back to the admitted message id when the turn is not in the detail", () => {
    const admitted = { ...optimistic, messageId: "msg_3" };
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_3", 3, "Ship it")]), admitted)).toBe(true);
    expect(isOptimisticMessageDelivered(detailWith([userMessage("msg_4", 4, "Ship it")]), admitted)).toBe(false);
  });

  it("ignores another chat's detail", () => {
    const other = detailWith([userMessage("msg_3", 3, "Ship it")], [turn("req_mine", "msg_3")], "chat_other");
    expect(isOptimisticMessageDelivered(other, optimistic)).toBe(false);
  });
});

describe("attachments in the transcript", () => {
  const place = "temporary/desktop-chat/att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4-flowers.jpg";
  const photoPart = {
    type: "attachment_reference", attachmentId: "mobile_upload_att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4", kind: "image", label: "flowers.jpg",
    mimeType: "image/jpeg", sizeBytes: 2_048, ownerReference: place,
  };
  const filePart = { type: "attachment_reference", attachmentId: "shell_upload_9f", kind: "file", label: "notes.txt" };

  function sentWith(parts: unknown[]) {
    return detailWith([{ ...userMessage("msg_1", 1, ""), parts } as unknown as ReturnType<typeof userMessage>]);
  }

  it("lists what a message was sent with, after its text", () => {
    const [message] = buildTranscript(sentWith([{ type: "text", text: "What is this?" }, photoPart, filePart]));

    expect(message).toMatchObject({
      text: "What is this?",
      attachments: [
        { id: "mobile_upload_att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4", label: "flowers.jpg", kind: "image", path: place },
        { id: "shell_upload_9f", label: "notes.txt", kind: "file" },
      ],
    });
    // An attachment the message gives no place for has none to show it from.
    expect(message!.attachments![1]).not.toHaveProperty("path");
  });

  it("keeps a message of attachments alone, with no text", () => {
    expect(buildTranscript(sentWith([photoPart]))).toMatchObject([{ text: "", attachments: [{ label: "flowers.jpg" }] }]);
  });

  it("leaves attachments out of a message that has none", () => {
    expect(buildTranscript(detailWith([userMessage("msg_1", 1, "Ship it")]))[0]).not.toHaveProperty("attachments");
  });

  it("shows a message being sent with the phone's own copies of its attachments", () => {
    const message = optimisticTranscriptMessage({
      ...optimistic,
      text: "",
      attachments: [{
        id: "att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4", uri: "file:///cache/flowers.jpg", name: "flowers.jpg", mimeType: "image/jpeg", kind: "image", sizeBytes: 2_048,
      }],
    });

    expect(message.attachments).toEqual([{
      id: "att_a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4", label: "flowers.jpg", kind: "image", path: place, localUri: "file:///cache/flowers.jpg",
    }]);
  });

  it("goes on showing a sent attachment from the phone once the computer's copy of the message takes over", () => {
    const transcript = buildTranscript(sentWith([photoPart, filePart]));

    const shown = withLocalAttachments(transcript, { [place]: "file:///cache/flowers.jpg" });

    expect(shown[0]!.attachments).toMatchObject([
      { label: "flowers.jpg", path: place, localUri: "file:///cache/flowers.jpg" },
      { label: "notes.txt" },
    ]);
    expect(shown[0]!.attachments![1]).not.toHaveProperty("localUri");
  });

  it("returns the same messages when none was sent from this phone", () => {
    const transcript = buildTranscript(sentWith([photoPart]));

    expect(withLocalAttachments(transcript, {})).toBe(transcript);
    expect(withLocalAttachments(transcript, { "temporary/desktop-chat/other.jpg": "file:///cache/other.jpg" })).toBe(transcript);
  });
});
