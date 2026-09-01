import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";

class FakeStream extends EventEmitter {}

function child(lines: string[], exitCode = 0, stderrLines: string[] = []) {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const process = new EventEmitter() as EventEmitter & {
    stdout: FakeStream;
    stderr: FakeStream;
    kill: ReturnType<typeof vi.fn>;
  };
  process.stdout = stdout;
  process.stderr = stderr;
  process.kill = vi.fn();
  queueMicrotask(() => {
    for (const line of lines) stdout.emit("data", Buffer.from(`${line}\n`));
    for (const line of stderrLines) stderr.emit("data", Buffer.from(`${line}\n`));
    process.emit("exit", exitCode, null);
  });
  return process;
}

const baseInput = {
  owner: { type: "personal" as const, ownerId: "owner_claude" },
  chatId: "chat_claude",
  turnId: "cturn_claude",
  runId: "run_claude",
  prompt: "inspect it",
  parts: [{ type: "text" as const, text: "inspect it" }],
  selection: {
    instanceId: "claude_code_default",
    model: "claude-sonnet-4-5",
    options: [{ id: "effort", value: "high" }],
  },
  interactionMode: "default",
  permissionMode: "auto_accept_edits",
  executionRoot: "/safe/project",
  signal: new AbortController().signal,
};

describe("Claude canonical Chat Provider adapter", () => {
  it("runs the selected model, effort, permission and streams native deltas", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude_session",
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello " } } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } }),
      JSON.stringify({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "hello world", session_id: "claude_session" }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });

    const events = [];
    for await (const event of adapter.start(baseInput)) events.push(event);

    const [command, args, options] = spawnFn.mock.calls[0]!;
    expect(command).toBe("claude");
    expect(args).toEqual(expect.arrayContaining([
      "--model", "claude-sonnet-4-5",
      "--effort", "high",
      "--permission-mode", "acceptEdits",
      "--output-format", "stream-json",
      "--include-partial-messages",
    ]));
    expect(options).toMatchObject({ cwd: "/safe/project" });
    expect(events).toEqual([
      {
        type: "state.updated",
        state: { sessionId: "claude_session", model: "claude-sonnet-4-6" },
      },
      { type: "assistant.delta", delta: "hello world" },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("projects Claude tool activity and safe published process text through the provider-neutral seam", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude_activity_session",
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "thinking",
            thinking: "Inspecting the manifest before building.",
          },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "tool_use",
            id: "tool_build",
            name: "Bash",
            input: {
              command: "pnpm build",
              cwd: "/home/matrix/home/apps/flappy-bird",
              headers: { Authorization: "Bearer secret-value" },
            },
          },
        },
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Built the app in ~/apps/flappy-bird." } } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Built the app in ~/apps/flappy-bird.",
        session_id: "claude_activity_session",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual(expect.arrayContaining([
      {
        type: "agent.activity",
        activityId: "reasoning_0",
        kind: "reasoning",
        label: "Thinking",
        status: "running",
      },
      {
        type: "agent.activity",
        activityId: "tool_build",
        kind: "command",
        label: "Run command",
        status: "running",
        preview: "pnpm build",
        previewKind: "command",
        detail: "Working directory: ~/apps/flappy-bird",
      },
      expect.objectContaining({
        type: "agent.activity",
        activityId: "tool_build",
        status: "completed",
      }),
    ]));
    expect(JSON.stringify(events)).not.toMatch(/secret-value|Authorization|\/home\/matrix\/home|Inspecting the manifest/);
  });

  it("uses unique activity ids when Claude restarts content block indexes", async () => {
    const thinkingBlock = [
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }),
    ];
    const spawnFn = vi.fn(() => child([
      ...thinkingBlock,
      ...thinkingBlock,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "done",
        session_id: "claude_restarted_indexes",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events.filter((event) => event.type === "agent.activity")).toEqual([
      expect.objectContaining({ activityId: "reasoning_0", status: "running" }),
      expect.objectContaining({ activityId: "reasoning_0", status: "completed" }),
      expect.objectContaining({ activityId: "reasoning_1", status: "running" }),
      expect.objectContaining({ activityId: "reasoning_1", status: "completed" }),
    ]);
  });

  it("keeps official Claude text blocks and completed command detail in provider order", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude_timeline_session",
        model: "claude-sonnet-4-6",
      }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "I’ll inspect the project first." },
        },
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool_build", name: "Bash", input: {} },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: "{\"command\":\"pnpm build\",\"cwd\":\"/home/matrix/home/apps/flappy-bird\"}" },
        },
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 1 } }),
      JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "The build is ready in /home/matrix/home/apps/flappy-bird." },
        },
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "The build is ready in /home/matrix/home/apps/flappy-bird.",
        session_id: "claude_timeline_session",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([
      {
        type: "state.updated",
        state: { sessionId: "claude_timeline_session", model: "claude-sonnet-4-6" },
      },
      {
        type: "assistant.delta",
        messageId: "claude_text_0",
        delta: "I’ll inspect the project first.",
      },
      {
        type: "agent.activity",
        activityId: "tool_build",
        kind: "command",
        label: "Run command",
        status: "running",
      },
      {
        type: "agent.activity",
        activityId: "tool_build",
        kind: "command",
        label: "Run command",
        status: "completed",
        preview: "pnpm build",
        previewKind: "command",
        detail: "Working directory: ~/apps/flappy-bird",
      },
      {
        type: "assistant.delta",
        messageId: "claude_text_1",
        delta: "The build is ready in ~/apps/flappy-bird.",
      },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("preserves harmless JSX closers and prose separators while redacting real unrelated absolute paths", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "Renders <App />; compare vite.config.ts / tsconfig.json; inspect /private/secret/file.",
        session_id: "claude_path_session",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toContainEqual({
      type: "assistant.delta",
      delta: "Renders <App />; compare vite.config.ts / tsconfig.json; inspect [redacted path]",
    });
  });

  it("coalesces a healthy long Claude text stream instead of failing on total event count", async () => {
    const deltas = Array.from({ length: 600 }, () => JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } },
    }));
    const spawnFn = vi.fn(() => child([
      ...deltas,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "x".repeat(600),
        session_id: "claude_long_session",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events.filter((event) => event.type === "assistant.delta")
      .map((event) => event.type === "assistant.delta" ? event.delta : "")
      .join("")).toBe("x".repeat(600));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("accepts a healthy long Claude stream beyond the legacy one-megabyte total cap", async () => {
    const progressLines = Array.from({ length: 540 }, (_, index) => JSON.stringify({
      type: "user",
      tool_use_result: {
        sequence: index,
        content: "x".repeat(2_000),
      },
    }));
    const spawnFn = vi.fn(() => child([
      ...progressLines,
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed after a long healthy stream",
        session_id: "claude_long_stream_session",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("discards an oversized Claude tool-input fragment without failing the Run", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_large_input", name: "Bash", input: {} },
        },
      }),
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "x".repeat(20_000) },
        },
      }),
      JSON.stringify({ type: "stream_event", event: { type: "content_block_stop", index: 0 } }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed after ignoring oversized tool input",
        session_id: "claude_large_tool_input_session",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toContainEqual(expect.objectContaining({
      type: "agent.activity",
      activityId: "tool_large_input",
      status: "completed",
    }));
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("executes with the owner Claude credential environment", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "authenticated", session_id: "claude_session" }),
    ]));
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn,
      resolveCredentialEnv: vi.fn(async () => ({
        PATH: "/credential/bin",
        ANTHROPIC_API_KEY: "owner-key",
      })),
    });

    for await (const _event of adapter.start(baseInput)) {
      // Drain the bounded native event stream.
    }

    expect(spawnFn.mock.calls[0]![2].env).toMatchObject({
      ANTHROPIC_API_KEY: "owner-key",
      HOME: "/home/matrix/home",
      MATRIX_HOME: "/home/matrix/home",
    });
  });

  it("uses the rotating funded credential and its shorter run deadline", async () => {
    const stdout = new FakeStream();
    const stderr = new FakeStream();
    const process = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stderr: FakeStream;
      kill: ReturnType<typeof vi.fn>;
    };
    process.stdout = stdout;
    process.stderr = stderr;
    process.kill = vi.fn(() => queueMicrotask(() => process.emit("exit", null, "SIGTERM")));
    const spawnFn = vi.fn(() => process);
    const adapter = createClaudeChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn,
      timeoutMs: 60_000,
      resolveCredentialLaunch: vi.fn(async () => ({
        env: {
          ANTHROPIC_API_KEY: `sk-matrix-funded-credential_123.${"A".repeat(43)}`,
          ANTHROPIC_BASE_URL: "https://relay.matrix-os.com",
        },
        fundedRunTimeoutMs: 10,
      })),
    });

    const events = [];
    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(spawnFn.mock.calls[0]![2].env).toMatchObject({
      ANTHROPIC_API_KEY: expect.stringMatching(/^sk-matrix-funded-/),
      ANTHROPIC_BASE_URL: "https://relay.matrix-os.com",
    });
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(events.at(-1)).toEqual({
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "service_unavailable",
        safeMessage: "Claude took too long to respond. Try the Run again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
  });

  it("resumes the persisted Claude session and maps full access explicitly", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "resumed", session_id: "claude_session" }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];
    for await (const event of adapter.resume!({
      ...baseInput,
      permissionMode: "full_access",
      resumeState: { sessionId: "claude_session" },
    })) events.push(event);

    const args = spawnFn.mock.calls[0]![1];
    expect(args).toEqual(expect.arrayContaining([
      "--resume", "claude_session",
      "--permission-mode", "bypassPermissions",
    ]));
    expect(events).toEqual([
      { type: "assistant.delta", delta: "resumed" },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("fails closed when Claude exits without a result event", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude_session",
        model: "claude-sonnet-4-6",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events.at(-1)).toEqual({
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "run_failed",
        safeMessage: "Claude returned an invalid response. Try the Run again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
  });

  it("classifies an unsupported Claude model without exposing Provider output", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "API Error: model claude-retired is not available for /home/matrix/private/token.txt",
        session_id: "claude_session",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events.at(-1)).toEqual({
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "model_unavailable",
        safeMessage: "The selected Claude model is unavailable. Choose another model and try again.",
        retryable: false,
        recoveryActions: ["select_provider"],
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/claude-retired|private|token\.txt/);
  });

  it("turns a Claude authentication failure into a safe setup action", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Authentication failed: invalid API key sk-ant-secret-value. Please run /login.",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "authorization_failed",
        safeMessage: "Claude needs to be connected before it can run. Open setup and connect Claude.",
        retryable: false,
        recoveryActions: ["open_setup_terminal"],
      },
    }]);
    expect(JSON.stringify(events)).not.toContain("sk-ant-secret-value");
  });

  it("classifies a Claude permission failure without presenting it as a connection failure", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        result: "Permission denied while using Bash in /safe/project/private.sh",
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "authorization_failed",
        safeMessage: "Claude was blocked by its current permissions. Review the permission mode and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    }]);
    expect(JSON.stringify(events)).not.toContain("private.sh");
  });

  it("offers setup when the Claude executable cannot start", async () => {
    const spawnFn = vi.fn(() => {
      throw new Error("spawn /private/bin/claude ENOENT with ANTHROPIC_API_KEY=secret");
    });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "provider_unavailable",
        safeMessage: "Claude is not available on this runtime. Open setup and install or reconnect Claude.",
        retryable: false,
        recoveryActions: ["open_setup_terminal"],
      },
    }]);
    expect(JSON.stringify(events)).not.toMatch(/private|ANTHROPIC|secret/);
  });

  it("classifies malformed Claude stream output as a safe protocol failure", async () => {
    const spawnFn = vi.fn(() => child(["{malformed provider payload with /private/path"]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "run_failed",
        safeMessage: "Claude returned an invalid response. Try the Run again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    }]);
    expect(JSON.stringify(events)).not.toMatch(/malformed|private/);
  });

  it("uses bounded Claude stderr as private evidence for an authentication category", async () => {
    const spawnFn = vi.fn(() => child([], 1, [
      `Authentication required. Run /login. secret=${"x".repeat(16_000)}`,
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "authorization_failed",
        safeMessage: "Claude needs to be connected before it can run. Open setup and connect Claude.",
        retryable: false,
        recoveryActions: ["open_setup_terminal"],
      },
    }]);
    expect(JSON.stringify(events)).not.toMatch(/Authentication required|secret|xxxx/);
  });

  it("handles Claude success-subtype error results as an opaque safe failure", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        total_cost_usd: 0,
        modelUsage: {},
      }),
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "run_failed",
        safeMessage: "Claude reported a failure before completing this Run. Try again, or open Claude setup if it continues.",
        retryable: true,
        recoveryActions: ["retry", "open_setup_terminal"],
      },
    }]);
  });

  it("keeps an unclassified Claude process exit generic and safe", async () => {
    const spawnFn = vi.fn(() => child([], 17, [
      "Unexpected provider detail at /private/runtime with credential=secret-value",
    ]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "run_failed",
        safeMessage: "Claude could not complete this Run. Check its connection and retry.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    }]);
    expect(JSON.stringify(events)).not.toMatch(/private|credential|secret-value/);
  });

  it("preserves cancellation as aborted without a failure reason", async () => {
    const controller = new AbortController();
    const stdout = new FakeStream();
    const stderr = new FakeStream();
    const process = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stderr: FakeStream;
      kill: ReturnType<typeof vi.fn>;
    };
    process.stdout = stdout;
    process.stderr = stderr;
    process.kill = vi.fn(() => queueMicrotask(() => process.emit("exit", null, "SIGTERM")));
    const spawnFn = vi.fn(() => {
      queueMicrotask(() => controller.abort());
      return process;
    });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start({ ...baseInput, signal: controller.signal })) events.push(event);

    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(events).toEqual([{ type: "run.completed", outcome: "aborted" }]);
  });

  it("trusts a successful result event even when Claude exits non-zero afterward", async () => {
    const spawnFn = vi.fn(() => child([
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "completed before exit",
        session_id: "claude_session",
      }),
    ], 1));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = [];

    for await (const event of adapter.start(baseInput)) events.push(event);

    expect(events).toEqual([
      {
        type: "state.updated",
        state: { sessionId: "claude_session" },
      },
      { type: "assistant.delta", delta: "completed before exit" },
      { type: "run.completed", outcome: "completed" },
    ]);
  });
});
