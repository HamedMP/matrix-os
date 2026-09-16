import { expect, it } from "vitest";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

it("attaches saved context to a user message through its turn, without a run ID", () => {
  const { chat, messages, turns, runs, activities } = createCanonicalChatFixture("completed").snapshot;
  const context = { version: 1 as const, requestHash: "a".repeat(64),
    agent: { id: "bot_meeting01", revision: 1, name: "Meeting helper", instructions: "Prepare a brief" },
    chats: [{ chatId: "chat_notes", title: "Meeting notes", throughSeq: 2, text: "Pinned notes", truncated: false }] };
  runs[0]!.context = context;
  expect(messages[0]!.runId).toBeUndefined();
  const projected = projectCanonicalTranscript({ record: { chat }, messages, turns, runs, activities });
  expect(projected[0]!.metadata?.chatRunContext).toEqual(context);
  expect(projected[0]!.content).toBe(messages[0]!.parts[0].type === "text" ? messages[0]!.parts[0].text : "");
});
