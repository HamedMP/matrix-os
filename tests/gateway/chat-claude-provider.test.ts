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
      { type: "assistant.delta", delta: "hello " },
      { type: "assistant.delta", delta: "world" },
      { type: "run.completed", outcome: "completed" },
    ]);
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
