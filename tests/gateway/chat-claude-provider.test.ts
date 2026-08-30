import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createClaudeChatProviderAdapter } from "../../packages/gateway/src/chat/claude-provider-adapter.js";

class FakeStream extends EventEmitter {}

function child(lines: string[], exitCode = 0) {
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
        safeMessage: "The Claude Run failed. Check Claude setup and try again.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    });
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
