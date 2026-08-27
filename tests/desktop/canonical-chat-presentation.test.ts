import { describe, expect, it } from "vitest";
import { CanonicalChatRunActivitySchema } from "@matrix-os/contracts";
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

  it("keeps typed activity in first-received order while projecting terminal states", () => {
    const { snapshot } = createCanonicalChatFixture("accepted");
    const run = snapshot.runs[0]!;
    const received = [
      {
        id: "activity_plan_running",
        type: "agent.activity",
        activityId: "plan_primary",
        kind: "plan",
        label: "Plan implementation",
        status: "running",
        occurredAt: "2026-08-26T00:00:03.000Z",
      },
      {
        id: "activity_command_completed",
        type: "agent.activity",
        activityId: "command_primary",
        kind: "command",
        label: "Run focused tests",
        status: "completed",
        summary: "Focused checks passed.",
        occurredAt: "2026-08-26T00:00:01.000Z",
      },
      {
        id: "activity_command_output",
        type: "tool.output",
        toolCallId: "command_primary",
        text: "This output must not replace the explicit summary.",
        truncated: false,
        occurredAt: "2026-08-26T00:00:01.500Z",
      },
      {
        id: "activity_mcp_completed",
        type: "agent.activity",
        activityId: "mcp_primary",
        kind: "mcp_tool",
        label: "Read issue context",
        status: "completed",
        occurredAt: "2026-08-26T00:00:01.750Z",
      },
      {
        id: "activity_mcp_output_one",
        type: "tool.output",
        toolCallId: "mcp_primary",
        text: "Loaded bounded issue metadata.",
        truncated: false,
        occurredAt: "2026-08-26T00:00:01.800Z",
      },
      {
        id: "activity_mcp_output_two",
        type: "tool.output",
        toolCallId: "mcp_primary",
        text: "No private fields were returned.",
        truncated: false,
        occurredAt: "2026-08-26T00:00:01.900Z",
      },
      {
        id: "activity_plan_partial",
        type: "agent.activity",
        activityId: "plan_primary",
        kind: "plan",
        label: "Plan implementation",
        status: "partial",
        summary: "Two of three steps completed.",
        occurredAt: "2026-08-26T00:00:02.000Z",
      },
      {
        id: "activity_search_cancelled",
        type: "agent.activity",
        activityId: "search_primary",
        kind: "web_search",
        label: "Search documentation",
        status: "cancelled",
        occurredAt: "2026-08-26T00:00:00.000Z",
      },
    ].map((activity) => CanonicalChatRunActivitySchema.parse({
      ...activity,
      chatId: snapshot.chat.id,
      runId: run.id,
    }));

    const [turn] = canonicalChatPresentation({
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: received,
    });

    expect(turn?.work).toEqual([{
      kind: "activity-group",
      id: `${run.id}:activities`,
      activities: [
        expect.objectContaining({
          id: "activity_plan_running",
          kind: "plan",
          state: "partial",
          label: "Plan implementation",
          detail: "Two of three steps completed.",
        }),
        expect.objectContaining({
          id: "activity_command_completed",
          kind: "command",
          state: "completed",
          label: "Run focused tests",
          detail: "Focused checks passed.",
        }),
        expect.objectContaining({
          id: "activity_mcp_completed",
          kind: "mcp_tool",
          state: "completed",
          label: "Read issue context",
          detail: "Loaded bounded issue metadata.\nNo private fields were returned.",
        }),
        expect.objectContaining({
          id: "activity_search_cancelled",
          kind: "web_search",
          state: "stopped",
          label: "Search documentation",
        }),
      ],
    }]);
  });
});
