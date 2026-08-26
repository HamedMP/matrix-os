import { describe, expect, it } from "vitest";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";

describe("canonical Chat presentation adapter", () => {
  it("projects canonical messages into the shared provider-neutral transcript", () => {
    const { snapshot } = createCanonicalChatFixture("completed");

    const turns = canonicalChatPresentation({
      messages: [...snapshot.messages, {
        id: "msg_fixture_answer",
        chatId: snapshot.chat.id,
        seq: 2,
        role: "assistant",
        state: "committed",
        turnId: snapshot.turns[0]!.id,
        runId: snapshot.runs[0]!.id,
        parts: [{ type: "text", text: "The canonical Chat contract is ready." }],
        createdAt: snapshot.runs[0]!.updatedAt,
      }],
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: snapshot.turns[0]?.id,
      active: false,
      user: { role: "user" },
      final: { role: "assistant" },
    });
  });
});
