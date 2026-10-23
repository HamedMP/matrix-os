import { describe, expect, it } from "vitest";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { groupMessages } from "../../shell/src/lib/chat.js";
import { projectCanonicalTranscript } from "../../shell/src/lib/canonical-chat-terminal-notices.js";

const date = "2026-10-23T00:00:00.000Z";
const at = (second: number) => `2026-10-23T00:00:${String(second).padStart(2, "0")}.000Z`;

function assistant(id: string, seq: number, text: string, createdAt = date) {
  return { id, chatId: "chat_test", seq, role: "assistant", state: "committed", turnId: "cturn_1", runId: "run_1",
    parts: [{ type: "text", text }], createdAt };
}

function tool(id: string, sequence: number, occurredAt = date) {
  return { id: `act_${id}`, chatId: "chat_test", runId: "run_1", sequence, occurredAt,
    type: "tool.progress", toolCallId: id, label: `Tool ${id}`, status: "completed" };
}

function delta(messageId: string, sequence: number, occurredAt = date) {
  return { id: `act_delta_${messageId}_${sequence}`, chatId: "chat_test", runId: "run_1", sequence, occurredAt,
    type: "assistant.delta", messageId, delta: "text" };
}

function detail(messages: unknown[], activities: unknown[]): CanonicalChatDetailResponse {
  return {
    messages: [{ id: "msg_user", chatId: "chat_test", seq: 1, role: "user", state: "committed", turnId: "cturn_1",
      parts: [{ type: "text", text: "Prompt" }], createdAt: date }, ...messages],
    turns: [{ id: "cturn_1", inputMessageId: "msg_user" }],
    runs: [{ id: "run_1", turnId: "cturn_1", attempt: 1, status: "completed", createdAt: date, updatedAt: date, completedAt: date,
      driverKind: "claude", selection: { model: "claude" } }],
    activities,
  } as unknown as CanonicalChatDetailResponse;
}

function shape(value: CanonicalChatDetailResponse): string[] {
  return groupMessages(projectCanonicalTranscript(value)).map((group) =>
    group.type === "tool_group" ? `tools:${group.messages.map((message) => message.tool).join(",")}` : group.message.content);
}

describe("Web canonical transcript tool interleaving", () => {
  it("groups tool calls between the text blocks they ran between", () => {
    const value = detail(
      [assistant("msg_a", 2, "First"), assistant("msg_b", 3, "Second"), assistant("msg_c", 4, "Final")],
      [
        tool("t1", 1), tool("t2", 2), tool("t3", 3),
        delta("msg_a", 4),
        tool("t4", 5), tool("t5", 6),
        delta("msg_b", 7),
        tool("t6", 8),
        delta("msg_c", 9),
      ],
    );
    expect(shape(value)).toEqual([
      "Prompt",
      "tools:Tool t1,Tool t2,Tool t3",
      "First",
      "tools:Tool t4,Tool t5",
      "Second",
      "tools:Tool t6",
      "Final",
    ]);
  });

  it("keeps tools that ran after the last text block after it", () => {
    const value = detail([assistant("msg_a", 2, "Intro")], [delta("msg_a", 1), tool("t1", 2), tool("t2", 3)]);
    expect(shape(value)).toEqual(["Prompt", "Intro", "tools:Tool t1,Tool t2"]);
  });

  it("falls back to timestamps when text has no delta activity", () => {
    const value = detail(
      [assistant("msg_a", 2, "First", at(2)), assistant("msg_b", 3, "Final", at(5))],
      [tool("t1", 1, at(1)), tool("t2", 2, at(3)), tool("t3", 3, at(4))],
    );
    expect(shape(value)).toEqual(["Prompt", "tools:Tool t1", "First", "tools:Tool t2,Tool t3", "Final"]);
  });

  it("keeps the existing single-block layout", () => {
    const value = detail([assistant("msg_a", 2, "Answer")], [tool("t1", 1), tool("t2", 2), delta("msg_a", 3)]);
    expect(shape(value)).toEqual(["Prompt", "tools:Tool t1,Tool t2", "Answer"]);
  });
});
