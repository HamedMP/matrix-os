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

  it("projects persisted run activity and assistant deltas while a Run is active", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const turn = snapshot.turns[0]!;
    const occurredAt = run.startedAt ?? run.createdAt;

    const turns = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: [
        {
          id: "activity_tool_running",
          chatId: snapshot.chat.id,
          runId: run.id,
          type: "tool.progress",
          toolCallId: "tool_fixture",
          label: "Reading project files",
          status: "running",
          occurredAt,
        },
        {
          id: "activity_delta_one",
          chatId: snapshot.chat.id,
          runId: run.id,
          type: "assistant.delta",
          messageId: "msg_fixture_stream",
          delta: "I found ",
          occurredAt,
        },
        {
          id: "activity_delta_two",
          chatId: snapshot.chat.id,
          runId: run.id,
          type: "assistant.delta",
          messageId: "msg_fixture_stream",
          delta: "the issue.",
          occurredAt,
        },
      ],
    });

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      id: turn.id,
      active: true,
      work: [{
        kind: "activity-group",
        activities: [{ label: "Reading project files", state: "running" }],
      }],
      final: {
        role: "assistant",
        markdown: "I found the issue.",
        copyText: "I found the issue.",
      },
    });
  });
});
