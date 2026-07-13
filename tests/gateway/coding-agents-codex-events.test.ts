import { describe, expect, it } from "vitest";
import {
  AgentThreadEventSchema,
  CODEX_VERIFIED_VERSION,
} from "../../packages/contracts/src/index.js";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";
import {
  CODEX_EXEC_CONTRACT,
  codexExecContractStatus,
} from "../../packages/gateway/src/coding-agents/codex-version.js";

const context = {
  threadId: "thread_codex_stream_1",
  now: () => new Date("2026-07-13T10:00:00.000Z"),
  nextEventId: (() => {
    let index = 0;
    return () => `evt_codex_${++index}`;
  })(),
};

describe("Codex structured event normalization", () => {
  it("gates runtime parsing against exact verified CLI versions", () => {
    expect(CODEX_EXEC_CONTRACT).toMatchObject({
      minimumVersion: "0.144.0",
      latestVerifiedVersion: "0.144.6",
    });
    expect(codexExecContractStatus("codex-cli 0.144.1")).toEqual({
      status: "unverified_older",
      version: "0.144.1",
    });
    expect(codexExecContractStatus("0.144.3")).toEqual({
      status: "verified",
      version: "0.144.3",
    });
    expect(codexExecContractStatus("codex-cli 0.144.4")).toEqual({
      status: "verified",
      version: "0.144.4",
    });
    expect(codexExecContractStatus("codex-cli 0.144.6")).toEqual({
      status: "verified",
      version: "0.144.6",
    });
    expect(codexExecContractStatus("codex-cli 0.144.7")).toEqual({
      status: "unverified_newer",
      version: "0.144.7",
    });
    expect(codexExecContractStatus("codex-cli 0.143.9")).toEqual({
      status: "unverified_older",
      version: "0.143.9",
    });
    expect(codexExecContractStatus("unknown")).toEqual({ status: "invalid" });
  });

  it("normalizes completed assistant messages into text lifecycle events", () => {
    const result = parseCodexExecJsonLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_17",
        type: "agent_message",
        text: "I found the failing route and updated its test.",
      },
    }), context);

    expect(result.events.map((event) => AgentThreadEventSchema.parse(event).type)).toEqual([
      "assistant.text.delta",
      "assistant.text.completed",
    ]);
    expect(result.events[0]).toMatchObject({
      messageId: "item_17",
      delta: "I found the failing route and updated its test.",
    });
  });

  it("normalizes command execution without exposing commands or raw output", () => {
    const started = parseCodexExecJsonLine(JSON.stringify({
      type: "item.started",
      item: {
        id: "item_4",
        type: "command_execution",
        command: "cat /home/matrix/.ssh/id_rsa",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }), context);
    const completed = parseCodexExecJsonLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_4",
        type: "command_execution",
        command: "cat /home/matrix/.ssh/id_rsa",
        aggregated_output: "secret-value",
        exit_code: 1,
        status: "failed",
      },
    }), context);

    expect(started.events).toEqual([
      expect.objectContaining({
        type: "tool.started",
        toolCallId: "item_4",
        displayName: "Run command",
        kind: "command",
      }),
    ]);
    expect(completed.events).toEqual([
      expect.objectContaining({
        type: "tool.output",
        toolCallId: "item_4",
        text: "Command produced output.",
        truncated: true,
      }),
      expect.objectContaining({
        type: "tool.completed",
        toolCallId: "item_4",
        outcome: "failed",
      }),
    ]);
    expect(JSON.stringify([...started.events, ...completed.events])).not.toMatch(
      /id_rsa|secret-value|\/home\/matrix/,
    );
  });

  it("normalizes bounded file changes and drops unsafe paths", () => {
    const result = parseCodexExecJsonLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "item_8",
        type: "file_change",
        status: "completed",
        changes: [
          { path: "packages/gateway/src/server.ts", kind: "update" },
          { path: "../private.txt", kind: "delete" },
          { path: "/home/matrix/private.txt", kind: "add" },
        ],
      },
    }), context);

    expect(result.events.map((event) => event.type)).toEqual([
      "tool.started",
      "file.changed",
      "tool.completed",
    ]);
    expect(result.events[1]).toMatchObject({
      type: "file.changed",
      path: "packages/gateway/src/server.ts",
      changeKind: "updated",
    });
    expect(JSON.stringify(result.events)).not.toMatch(/private\.txt|\/home\/matrix/);
  });

  it("returns provider resume identity and terminal turn outcomes separately", () => {
    expect(parseCodexExecJsonLine(JSON.stringify({
      type: "thread.started",
      thread_id: "019f-codex-thread-123",
    }), context)).toEqual({
      events: [],
      providerThreadId: "019f-codex-thread-123",
    });

    expect(parseCodexExecJsonLine(JSON.stringify({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 4,
        output_tokens: 2,
        reasoning_output_tokens: 1,
      },
    }), context)).toEqual({ events: [], outcome: "completed" });

    expect(parseCodexExecJsonLine(JSON.stringify({
      type: "turn.failed",
      error: { message: "provider failed in /home/matrix/private" },
    }), context)).toEqual({ events: [], outcome: "failed" });
  });

  it("ignores unknown events and rejects malformed or oversized external frames", () => {
    expect(parseCodexExecJsonLine(JSON.stringify({ type: "future.event", value: 1 }), context))
      .toEqual({ events: [] });
    expect(parseCodexExecJsonLine("not json", context)).toEqual({ events: [] });
    expect(parseCodexExecJsonLine("x".repeat(64 * 1024 + 1), context)).toEqual({ events: [] });
    expect(parseCodexExecJsonLine(JSON.stringify({
      type: "item.completed",
      item: { id: "../bad", type: "agent_message", text: "unsafe id" },
    }), context)).toEqual({ events: [] });
  });

  it("normalizes app-server control records into canonical thread events", () => {
    const approval = parseCodexExecJsonLine(JSON.stringify({
      type: "matrix.codex.approval.requested",
      approvalId: "appr_codex_11111111111111111111111111111111",
      correlationId: "corr_codex_22222222222222222222222222222222",
      title: "Run command",
      safeDescription: "The coding agent wants to run a command.",
      actionKind: "command",
      risk: "medium",
      allowedDecisions: ["approve", "decline", "cancel"],
    }), context);
    expect(approval.events[0]).toMatchObject({
      type: "approval.requested",
      approval: {
        approvalId: "appr_codex_11111111111111111111111111111111",
        allowedDecisions: ["approve", "decline", "cancel"],
      },
    });

    const input = parseCodexExecJsonLine(JSON.stringify({
      type: "matrix.codex.user_input.requested",
      requestId: "req_codex_33333333333333333333333333333333",
      correlationId: "corr_codex_44444444444444444444444444444444",
      title: "Approach",
      safeDescription: "The coding agent needs more information.",
      questions: [{
        questionId: "question_codex_555555555555555555555555",
        header: "Approach",
        question: "Which approach should be used?",
        options: [{ label: "Minimal", description: "Make the smallest change." }],
        allowOther: true,
        secret: false,
      }],
    }), context);
    expect(input.events[0]).toMatchObject({
      type: "user_input.requested",
      request: {
        requestId: "req_codex_33333333333333333333333333333333",
        questions: [expect.objectContaining({ header: "Approach" })],
      },
    });

    const delta = parseCodexExecJsonLine(JSON.stringify({
      type: "matrix.codex.assistant.delta",
      delta: "Working on it.",
    }), context);
    expect(delta.events[0]).toMatchObject({
      type: "assistant.text.delta",
      delta: "Working on it.",
    });
  });
});
