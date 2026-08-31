import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentThreadSummary,
  CreateAgentThreadRequest,
} from "@matrix-os/contracts";
import {
  createOpenCodeCodingAgentProvider,
  type OpenCodeSpawnFn,
} from "../../packages/gateway/src/coding-agents/opencode-provider.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";

const principal: RequestPrincipal = { userId: "owner_user", source: "jwt" };
const now = new Date("2026-08-31T00:00:00.000Z");
const sessionId = "ses_1234567890abcdef";

function thread(): AgentThreadSummary {
  return {
    id: "thread_019f8e9c1e8c7bedbd12eda826fd07",
    providerId: "opencode",
    title: "OpenCode run",
    status: "queued",
    attention: "none",
    projectId: "repo-main",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function request(overrides: Partial<CreateAgentThreadRequest> = {}): CreateAgentThreadRequest {
  return {
    providerId: "opencode",
    prompt: "Inspect the project",
    projectId: "repo-main",
    clientRequestId: "req_opencode_1",
    model: "anthropic:claude-sonnet-5",
    sandboxMode: "read_only",
    ...overrides,
  };
}

function ids() {
  let value = 0;
  return () => `evt_${++value}_opencode`;
}

function line(type: string, value: Record<string, unknown>): string {
  return JSON.stringify({ type, timestamp: 1_788_134_400_000, sessionID: sessionId, ...value });
}

function fakeSpawn(lines: string[], exitCode = 0) {
  const calls: Array<{ command: string; args: string[]; cwd: string; env: Record<string, string> }> = [];
  const kills: NodeJS.Signals[] = [];
  const spawnFn: OpenCodeSpawnFn = (command, args, options) => {
    calls.push({ command, args, ...options });
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit: Array<(code: number | null) => void> = [];
    const error: Array<(value: Error) => void> = [];
    queueMicrotask(() => {
      for (const value of lines) stdout.emit("data", Buffer.from(`${value}\n`));
      exit.forEach((listener) => listener(exitCode));
    });
    return {
      stdout,
      stderr,
      once(event: "exit" | "error", listener: never) {
        if (event === "exit") exit.push(listener);
        else error.push(listener);
      },
      kill(signal: NodeJS.Signals) {
        kills.push(signal);
        queueMicrotask(() => exit.forEach((listener) => listener(null)));
      },
    };
  };
  return { calls, kills, spawnFn };
}

function provider(spawnFn: OpenCodeSpawnFn, overrides: Record<string, unknown> = {}) {
  return createOpenCodeCodingAgentProvider({
    homePath: "/home/matrix/home",
    spawnFn,
    resolveProjectPath: async () => "/work/repo",
    resolveCredentialLaunch: async () => ({
      env: {
        ANTHROPIC_API_KEY: "selected-key",
        ANTHROPIC_BASE_URL: "https://relay.example.test",
      },
    }),
    ...overrides,
  });
}

describe("OpenCode coding-agent provider", () => {
  it("runs the verified JSON contract with exact model, safe config, and selected credentials", async () => {
    const fake = fakeSpawn([
      line("step_start", { part: { id: "part_step", type: "step-start" } }),
      line("text", { part: { id: "part_text", type: "text", text: "Done", time: { end: 1 } } }),
    ]);
    const adapter = provider(fake.spawnFn, {
      env: { PATH: "/runtime/bin", UPGRADE_TOKEN: "gateway-secret" },
    });

    const result = await adapter.startThread({ principal, thread: thread(), request: request(), now: () => now, nextEventId: ids() });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.args).toEqual([
      "run", "--format", "json", "--pure", "--model", "anthropic/claude-sonnet-5", "--", "Inspect the project",
    ]);
    expect(fake.calls[0]!.env).toMatchObject({
      PATH: "/runtime/bin",
      ANTHROPIC_API_KEY: "selected-key",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_CONFIG_CONTENT: expect.any(String),
    });
    expect(fake.calls[0]!.env).not.toHaveProperty("UPGRADE_TOKEN");
    const config = JSON.parse(fake.calls[0]!.env.OPENCODE_CONFIG_CONTENT!);
    expect(config).toMatchObject({
      permission: { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" },
      provider: { anthropic: { options: { baseURL: "https://relay.example.test" } } },
    });
    expect(config.permission).not.toHaveProperty("webfetch");
    expect(config.permission).not.toHaveProperty("websearch");
    expect(result).toMatchObject({
      resumeState: { conversationId: expect.stringContaining(sessionId) },
      events: expect.arrayContaining([
        expect.objectContaining({ type: "assistant.text.delta", delta: "Done" }),
        expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
      ]),
    });
  });

  it("normalizes completed tool output and provider errors without leaking raw details", async () => {
    const fake = fakeSpawn([
      line("tool_use", {
        part: {
          id: "part_tool", type: "tool", callID: "call|unsafe", tool: "read",
          state: { status: "completed", output: "file contents", time: { start: 1, end: 2 } },
        },
      }),
      line("error", { error: { name: "ProviderAuthError", data: { message: "secret upstream detail" } } }),
    ]);
    const result = await provider(fake.spawnFn).startThread({
      principal, thread: thread(), request: request(), now: () => now, nextEventId: ids(),
    });

    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.started", toolCallId: "call_unsafe" }),
      expect.objectContaining({ type: "tool.output", text: "file contents" }),
      expect.objectContaining({ type: "tool.completed", outcome: "success" }),
      expect.objectContaining({ type: "thread.error", error: expect.objectContaining({ safeMessage: expect.any(String) }) }),
      expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("secret upstream detail");
  });

  it("resumes the exact provider session and preserves its working directory", async () => {
    const first = fakeSpawn([line("text", { part: { id: "one", type: "text", text: "First", time: { end: 1 } } })]);
    const adapter = provider(first.spawnFn);
    const started = await adapter.startThread({
      principal, thread: thread(), request: request(), now: () => now, nextEventId: ids(),
    });
    const resumeState = started.resumeState!;
    const second = fakeSpawn([line("text", { part: { id: "two", type: "text", text: "Second", time: { end: 2 } } })]);
    const resumed = provider(second.spawnFn);

    await resumed.resumeTurn!({
      principal,
      thread: { ...thread(), status: "idle" },
      turn: { turnId: "turn_123", message: "Continue", model: "anthropic:claude-sonnet-5", sandboxMode: "read_only" },
      resumeState,
      signal: AbortSignal.timeout(1_000),
      now: () => now,
      nextEventId: ids(),
    });

    expect(second.calls[0]!.cwd).toBe("/work/repo");
    expect(second.calls[0]!.args).toEqual(expect.arrayContaining(["--session", sessionId, "Continue"]));
  });

  it("fails closed before spawn for unsupported sandbox or unavailable credentials", async () => {
    const fake = fakeSpawn([]);
    const noCredentials = provider(fake.spawnFn, {
      resolveCredentialLaunch: async () => { throw new Error("private auth detail"); },
    });
    const authFailure = await noCredentials.startThread({
      principal, thread: thread(), request: request(), now: () => now, nextEventId: ids(),
    });
    const unsafe = await provider(fake.spawnFn).startThread({
      principal,
      thread: thread(),
      request: request({ sandboxMode: "workspace_write" }),
      now: () => now,
      nextEventId: ids(),
    });

    expect(fake.calls).toHaveLength(0);
    expect(JSON.stringify(authFailure)).not.toContain("private auth detail");
    expect(unsafe.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.error", error: expect.objectContaining({ code: "sandbox_unavailable" }) }),
    ]));
  });

  it("reports credential resolution cancellation as aborted before spawn", async () => {
    const fake = fakeSpawn([]);
    const controller = new AbortController();
    const adapter = provider(fake.spawnFn, {
      resolveCredentialLaunch: async () => {
        controller.abort();
        throw new Error("private cancellation detail");
      },
    });

    const result = await adapter.startThread({
      principal,
      thread: thread(),
      request: request(),
      signal: controller.signal,
      now: () => now,
      nextEventId: ids(),
    });

    expect(fake.calls).toHaveLength(0);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "aborted" }),
    ]));
    expect(result.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.error" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("private cancellation detail");
  });

  it("bounds a hung child even when it ignores graceful termination", async () => {
    vi.useFakeTimers();
    const kills: NodeJS.Signals[] = [];
    const spawnFn: OpenCodeSpawnFn = () => ({
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      once: vi.fn(),
      kill(signal) { kills.push(signal); },
    });
    const adapter = provider(spawnFn, { runTimeoutMs: 20, killGraceMs: 10 });
    const pending = adapter.startThread({
      principal, thread: thread(), request: request(), now: () => now, nextEventId: ids(),
    });

    await vi.advanceTimersByTimeAsync(31);
    const result = await pending;
    vi.useRealTimers();

    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
    ]));
  });

  it("keeps explicit cancellation aborted when kill grace outlives the run timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const kills: NodeJS.Signals[] = [];
    const adapter = provider(() => ({
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      once: vi.fn(),
      kill(signal) { kills.push(signal); },
    }), { runTimeoutMs: 20, killGraceMs: 30 });

    try {
      const pending = adapter.startThread({
        principal,
        thread: thread(),
        request: request(),
        signal: controller.signal,
        now: () => now,
        nextEventId: ids(),
      });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(31);

      expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(pending).resolves.toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "thread.completed", outcome: "aborted" }),
        ]),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a timeout failed when cancellation races after the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const kills: NodeJS.Signals[] = [];
    const adapter = provider(() => ({
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      once: vi.fn(),
      kill(signal) { kills.push(signal); },
    }), { runTimeoutMs: 20, killGraceMs: 30 });

    try {
      const pending = adapter.startThread({
        principal,
        thread: thread(),
        request: request(),
        signal: controller.signal,
        now: () => now,
        nextEventId: ids(),
      });
      await vi.advanceTimersByTimeAsync(21);
      controller.abort();
      await vi.advanceTimersByTimeAsync(30);

      expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
      await expect(pending).resolves.toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
        ]),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops a child when credentials return after the run signal was already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const kills: NodeJS.Signals[] = [];
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit: Array<(code: number | null) => void> = [];
    const adapter = provider(() => ({
      stdout,
      stderr,
      once(event: "exit" | "error", listener: never) {
        if (event === "exit") exit.push(listener);
      },
      kill(signal) {
        kills.push(signal);
        queueMicrotask(() => exit.forEach((listener) => listener(null)));
      },
    }), {
      resolveCredentialLaunch: async () => {
        controller.abort();
        return { env: { ANTHROPIC_API_KEY: "selected-key" } };
      },
      runTimeoutMs: 10_000,
      killGraceMs: 10,
    });

    try {
      const pending = adapter.startThread({
        principal,
        thread: thread(),
        request: request(),
        signal: controller.signal,
        now: () => now,
        nextEventId: ids(),
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(kills).toEqual(["SIGTERM"]);
      await expect(pending).resolves.toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "thread.completed", outcome: "aborted" }),
        ]),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates a flood of unique unsupported part records without growing dedup state", async () => {
    const fake = fakeSpawn(Array.from({ length: 4_200 }, (_, index) =>
      line("step_start", { part: { id: `unsupported_${index}`, type: "step-start" } })
    ));

    const result = await provider(fake.spawnFn).startThread({
      principal, thread: thread(), request: request(), now: () => now, nextEventId: ids(),
    });

    expect(fake.kills).toContain("SIGTERM");
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
    ]));
  });

  it("reports binary presence independently from credentials", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "1.16.0\n", stderr: "" }));
    const adapter = provider(fakeSpawn([]).spawnFn, { runCommand });
    await expect(adapter.getSummary!({ principal, now: () => now, signal: AbortSignal.timeout(1_000) }))
      .resolves.toMatchObject({
        id: "opencode",
        kind: "opencode",
        availability: "auth_required",
        installStatus: "installed",
        authStatus: "unknown",
      });
    expect(runCommand).toHaveBeenCalledWith("opencode", ["--version"], expect.objectContaining({ timeout: 1_500 }));
  });
});
