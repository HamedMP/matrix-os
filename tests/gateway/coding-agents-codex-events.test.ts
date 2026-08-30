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
      latestVerifiedVersion: CODEX_VERIFIED_VERSION,
      verifiedVersions: {
        "0.144.3": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.146.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.147.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.149.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.149.1": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.150.0": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        "0.150.1": {
          schemaSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
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
    expect(codexExecContractStatus("codex-cli 0.146.0")).toEqual({
      status: "verified",
      version: "0.146.0",
    });
    expect(codexExecContractStatus("codex-cli 0.147.0")).toEqual({
      status: "verified",
      version: "0.147.0",
    });
    expect(codexExecContractStatus("codex-cli 0.147.1")).toEqual({
      status: "unverified_older",
      version: "0.147.1",
    });
    expect(codexExecContractStatus("codex-cli 0.149.0")).toEqual({
      status: "verified",
      version: "0.149.0",
    });
    expect(codexExecContractStatus("codex-cli 0.149.1")).toEqual({
      status: "verified",
      version: "0.149.1",
    });
    expect(codexExecContractStatus("codex-cli 0.150.0")).toEqual({
      status: "verified",
      version: "0.150.0",
    });
    expect(codexExecContractStatus("codex-cli 0.150.1")).toEqual({
      status: "verified",
      version: "0.150.1",
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

  it("projects Codex reasoning as a neutral lifecycle without hidden reasoning text", () => {
    const started = parseCodexExecJsonLine(JSON.stringify({
      type: "item.started",
      item: {
        id: "reasoning_1",
        type: "reasoning",
        text: "hidden chain of thought with API_TOKEN=secret-value",
      },
    }), context);
    const completed = parseCodexExecJsonLine(JSON.stringify({
      type: "item.completed",
      item: {
        id: "reasoning_1",
        type: "reasoning",
        text: "hidden chain of thought with API_TOKEN=secret-value",
      },
    }), context);

    expect(started.events).toEqual([
      expect.objectContaining({ type: "tool.started", toolCallId: "reasoning_1", displayName: "Thinking", kind: "reasoning" }),
    ]);
    expect(completed.events).toEqual([
      expect.objectContaining({ type: "tool.completed", toolCallId: "reasoning_1", outcome: "success" }),
    ]);
    expect(JSON.stringify([...started.events, ...completed.events])).not.toMatch(/hidden chain|secret-value|API_TOKEN/);
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

  it("names the bounded Codex MCP tool without exposing its arguments", () => {
    const started = parseCodexExecJsonLine(JSON.stringify({
      type: "item.started",
      item: {
        id: "item_mcp_tool",
        type: "mcp_tool_call",
        server: "linear",
        tool: "get_issue",
        arguments: { token: "secret-value", issue: "OM-134" },
        status: "in_progress",
      },
    }), context);

    expect(started.events).toEqual([
      expect.objectContaining({
        type: "tool.started",
        toolCallId: "item_mcp_tool",
        displayName: "Use linear.get_issue",
        kind: "tool",
      }),
    ]);
    expect(JSON.stringify(started.events)).not.toMatch(/secret-value|arguments|OM-134/);
  });

  it("keeps a bounded safe Codex command preview while rejecting sensitive command text", () => {
    const safe = parseCodexExecJsonLine(JSON.stringify({
      type: "item.started",
      item: {
        id: "item_safe_command",
        type: "command_execution",
        command: "pnpm build",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }), context);
    const sensitive = parseCodexExecJsonLine(JSON.stringify({
      type: "item.started",
      item: {
        id: "item_sensitive_command",
        type: "command_execution",
        command: "deploy API_TOKEN=secret-value",
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    }), context);

    expect(safe.events[0]).toMatchObject({
      type: "tool.started",
      preview: "pnpm build",
      previewKind: "command",
    });
    expect(sensitive.events[0]).toMatchObject({ type: "tool.started", displayName: "Run command" });
    expect(sensitive.events[0]).not.toHaveProperty("preview");
    expect(JSON.stringify(sensitive.events)).not.toMatch(/secret-value|API_TOKEN/);
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
    expect(result.events[0]).toMatchObject({
      type: "tool.started",
      preview: "packages/gateway/src/server.ts",
      previewKind: "path",
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
