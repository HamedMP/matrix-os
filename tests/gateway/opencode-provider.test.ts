import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentThreadEvent,
  AgentThreadSummary,
  CreateAgentThreadRequest,
} from "@matrix-os/contracts";
import {
  createOpenCodeCodingAgentProvider,
  type OpenCodeSpawnFn,
} from "../../packages/gateway/src/coding-agents/opencode-provider.js";
import { createCodingHarnessCredentialResolver } from "../../packages/gateway/src/coding-agents/harness-credentials.js";
import type { RequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { providerSettingsCanonicalFixture } from "./provider-settings-test-support.js";

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
      let thrown: unknown;
      try {
        for (const value of lines) stdout.emit("data", Buffer.from(`${value}\n`));
      } catch (error: unknown) {
        thrown = error;
      } finally {
        stdout.emit("end");
        exit.forEach((listener) => listener(exitCode));
      }
      if (thrown) throw thrown;
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
      "run", "--format", "json", "--pure", "--title", "Matrix Chat",
      "--model", "anthropic/claude-sonnet-5", "Inspect the project",
    ]);
    expect(fake.calls[0]!.env).toMatchObject({
      PATH: "/runtime/bin",
      ANTHROPIC_API_KEY: "selected-key",
      OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      OPENCODE_CONFIG_CONTENT: expect.any(String),
    });
    expect(fake.calls[0]!.env).not.toHaveProperty("UPGRADE_TOKEN");
    const config = JSON.parse(fake.calls[0]!.env.OPENCODE_CONFIG_CONTENT!);
    expect(config).toMatchObject({
      snapshot: false,
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

  it.each([
    ["- list three colors", " - list three colors"],
    ["@hamed thanks", " @hamed thanks"],
    ["plain prompt", "plain prompt"],
  ])("passes prompt text as OpenCode's message positional: %j", async (prompt, expected) => {
    const fake = fakeSpawn([
      line("text", { part: { id: "part_text", type: "text", text: "Done", time: { end: 1 } } }),
    ]);

    await provider(fake.spawnFn).startThread({
      principal,
      thread: thread(),
      request: request({ prompt }),
      now: () => now,
      nextEventId: ids(),
    });

    expect(fake.calls[0]!.args.at(-1)).toBe(expected);
    expect(fake.calls[0]!.args).not.toContain("--");
  });

  it("publishes normalized output before returning the terminal result", async () => {
    const fake = fakeSpawn([
      line("text", { part: { id: "part_stream", type: "text", text: "Streaming", time: { end: 1 } } }),
    ]);
    const published: AgentThreadEvent[] = [];

    const result = await provider(fake.spawnFn).startThread({
      principal,
      thread: thread(),
      request: request(),
      publishEvents: async (batch) => {
        published.push(...batch.events);
      },
      now: () => now,
      nextEventId: ids(),
    });

    expect(published).toEqual([
      expect.objectContaining({ type: "thread.status", status: "running" }),
      expect.objectContaining({ type: "assistant.text.delta", delta: "Streaming" }),
      expect.objectContaining({ type: "assistant.text.completed" }),
    ]);
    expect(result.events).toEqual([
      expect.objectContaining({ type: "thread.status", status: "completed" }),
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]);
  });

  it("lets OpenCode use its configured default model for the native Terminal profile", async () => {
    const fake = fakeSpawn([
      line("text", { part: { id: "part_text", type: "text", text: "Done", time: { end: 1 } } }),
    ]);
    const adapter = provider(fake.spawnFn);

    await adapter.startThread({
      principal,
      thread: thread(),
      request: request({ model: "provider-default" }),
      now: () => now,
      nextEventId: ids(),
    });

    expect(fake.calls[0]!.args).not.toContain("--model");
  });

  it("runs an exact model through owner-local Terminal auth in the same HOME used for readiness", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "opencode-native-run-"));
    const authDirectory = join(homePath, ".local", "share", "opencode");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(join(authDirectory, "auth.json"), "{\"anthropic\":{}}\n", { mode: 0o600 });
    const resolveCredentialLaunch = createCodingHarnessCredentialResolver({
      harness: "opencode",
      homePath,
      settings: {
        getSnapshot: async () => ({ ...providerSettingsCanonicalFixture(), harnesses: [] }),
      },
    });
    const fake = fakeSpawn([
      line("text", { part: { id: "part_text", type: "text", text: "Done", time: { end: 1 } } }),
    ]);
    try {
      const adapter = provider(fake.spawnFn, {
        homePath,
        env: { HOME: "/wrong-service-home", PATH: "/runtime/bin" },
        resolveCredentialLaunch,
      });

      const result = await adapter.startThread({
        principal,
        thread: thread(),
        request: request({ model: "anthropic:claude-sonnet-5" }),
        now: () => now,
        nextEventId: ids(),
      });

      expect(fake.calls[0]!.env).toMatchObject({ HOME: homePath, PATH: "/runtime/bin" });
      expect(fake.calls[0]!.env).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(fake.calls[0]!.args).toEqual(expect.arrayContaining([
        "--pure", "--model", "anthropic/claude-sonnet-5",
      ]));
      expect(result.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
      ]));
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
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

  it("bounds oversized tool output before canonical contract parsing", async () => {
    const rawOutput = "x".repeat(4_001);
    const fake = fakeSpawn([
      line("tool_use", {
        part: {
          id: "part_large_tool",
          type: "tool",
          callID: "call_large_tool",
          tool: "read",
          state: { status: "completed", output: rawOutput, time: { start: 1, end: 2 } },
        },
      }),
    ]);

    const result = await provider(fake.spawnFn).startThread({
      principal,
      thread: thread(),
      request: request(),
      now: () => now,
      nextEventId: ids(),
    });

    const output = result.events.find((event) => event.type === "tool.output");
    expect(output).toMatchObject({
      type: "tool.output",
      toolCallId: "call_large_tool",
      truncated: true,
    });
    expect(output?.type === "tool.output" ? output.text : "").toHaveLength(3_500);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]));
  });

  it("chunks oversized assistant text into canonical deltas", async () => {
    const rawText = `${" ".repeat(3_500)}${"architecture ".repeat(500)}`;
    const fake = fakeSpawn([
      line("text", {
        part: { id: "part_large_text", type: "text", text: rawText, time: { end: 1 } },
      }),
    ]);

    const result = await provider(fake.spawnFn).startThread({
      principal,
      thread: thread(),
      request: request(),
      now: () => now,
      nextEventId: ids(),
    });

    const deltas = result.events.filter((event) => event.type === "assistant.text.delta");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((event) => event.delta.length <= 4_000)).toBe(true);
    expect(deltas.map((event) => event.delta).join("")).toBe(rawText);
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]));
  });

  it("projects raw file, search, and command tools with safe canonical activity details", async () => {
    const tools = [
      ["read", { filePath: "/work/repo/src/index.ts" }],
      ["list", { path: "/work/repo/src" }],
      ["glob", { pattern: "**/*.ts", path: "/work/repo/src" }],
      ["grep", { pattern: "TODO", path: "/work/repo/src" }],
      ["bash", { command: "pnpm test", cwd: "/work/repo" }],
      ["write", { filePath: "/work/repo/src/generated.ts", content: "private raw credential" }],
    ] as const;
    const fake = fakeSpawn(tools.map(([tool, input], index) => line("tool_use", {
      part: {
        id: `part_${tool}`,
        type: "tool",
        callID: `call_${index}`,
        tool,
        state: { status: "completed", input, output: "ok", time: { start: 1, end: 2 } },
      },
    })));

    const result = await provider(fake.spawnFn).startThread({
      principal, thread: thread(), request: request(), now: () => now, nextEventId: ids(),
    });
    const started = result.events.filter((event) => event.type === "tool.started");
    const completed = result.events.filter((event) => event.type === "tool.completed");

    expect(started).toMatchObject([
      { displayName: "Read file", kind: "dynamic_tool", preview: "src/index.ts", previewKind: "path" },
      { displayName: "List files", kind: "dynamic_tool", preview: "src", previewKind: "path" },
      { displayName: "Find files", kind: "dynamic_tool", preview: "**/*.ts", previewKind: "text", detail: "In: src" },
      { displayName: "Search files", kind: "dynamic_tool", preview: "TODO", previewKind: "text", detail: "In: src" },
      { displayName: "Run command", kind: "command", preview: "pnpm test", previewKind: "command", detail: "Working directory: ." },
      { displayName: "Update file", kind: "file_change", preview: "src/generated.ts", previewKind: "path" },
    ]);
    expect(completed).toHaveLength(tools.length);
    expect(completed.every((event) => event.type === "tool.completed" && event.outcome === "success")).toBe(true);
    expect(JSON.stringify(started)).not.toMatch(/private raw|credential|\/work\/repo/);
  });

  it("redacts a shell-redirected absolute path instead of failing a healthy OpenCode run", async () => {
    const fake = fakeSpawn([
      line("tool_use", {
        part: {
          id: "part_database_check",
          type: "tool",
          callID: "call_database_check",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "echo ok 2>/tmp/opencode.log" },
            output: "ok",
            time: { start: 1, end: 2 },
          },
        },
      }),
      line("text", {
        part: { id: "part_done", type: "text", text: "Done", time: { end: 3 } },
      }),
    ]);

    const result = await provider(fake.spawnFn).startThread({
      principal,
      thread: thread(),
      request: request(),
      now: () => now,
      nextEventId: ids(),
    });

    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "tool.started",
        toolCallId: "call_database_check",
        displayName: "Run command",
        kind: "command",
        preview: "echo ok 2>[redacted path]",
        previewKind: "command",
      }),
      expect.objectContaining({ type: "tool.completed", toolCallId: "call_database_check", outcome: "success" }),
      expect.objectContaining({ type: "assistant.text.delta", delta: "Done" }),
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("/tmp/opencode.log");
  });

  it("includes owner-safe file and structured references in the OpenCode prompt", async () => {
    const fake = fakeSpawn([
      line("text", { part: { id: "part_text", type: "text", text: "Done", time: { end: 1 } } }),
    ]);

    await provider(fake.spawnFn).startThread({
      principal,
      thread: thread(),
      request: request({
        prompt: "Review this",
        attachments: [
          { id: "file:1", kind: "file", label: "Auth source", path: "src/auth.ts" },
          { id: "review:1", kind: "structured_ref", label: "Review hunk", path: "src/review.ts" },
        ],
      }),
      now: () => now,
      nextEventId: ids(),
    });

    expect(fake.calls[0]!.args.at(-1)).toBe(
      "Review this\n\nContext references:\n- Auth source: src/auth.ts\n- Review hunk: src/review.ts",
    );
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

  it("settles cancellation while credential resolution is blocked", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn([]);
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const adapter = provider(fake.spawnFn, {
      resolveCredentialLaunch: (signal) => {
        receivedSignal = signal;
        return new Promise(() => {});
      },
      runTimeoutMs: 10_000,
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
      const settled = vi.fn();
      void pending.then(settled);
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      expect(receivedSignal).toBe(controller.signal);
      expect(settled).toHaveBeenCalledWith(expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "thread.completed", outcome: "aborted" }),
        ]),
      }));
      expect(fake.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("arms the run deadline before blocked credential resolution", async () => {
    vi.useFakeTimers();
    const fake = fakeSpawn([]);
    const adapter = provider(fake.spawnFn, {
      resolveCredentialLaunch: async () => await new Promise(() => {}),
      runTimeoutMs: 20,
    });
    try {
      const pending = adapter.startThread({
        principal,
        thread: thread(),
        request: request(),
        now: () => now,
        nextEventId: ids(),
      });
      const settled = vi.fn();
      void pending.then(settled);
      await vi.advanceTimersByTimeAsync(21);

      expect(settled).toHaveBeenCalledWith(expect.objectContaining({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
        ]),
      }));
      expect(fake.calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a resumed run signal deadline during credential resolution as failed", async () => {
    const fake = fakeSpawn([]);
    const controller = new AbortController();
    const adapter = provider(fake.spawnFn, {
      resolveCredentialLaunch: async () => await new Promise(() => {}),
      runTimeoutMs: 10_000,
    });
    const pending = adapter.resumeTurn!({
      principal,
      thread: { ...thread(), status: "idle" },
      turn: {
        turnId: "turn_deadline",
        message: "Continue",
        model: "anthropic:claude-sonnet-5",
        sandboxMode: "read_only",
      },
      resumeState: {
        conversationId: JSON.stringify({ s: sessionId, c: "/work/repo" }),
      },
      signal: controller.signal,
      now: () => now,
      nextEventId: ids(),
    });
    controller.abort(new DOMException("The operation timed out", "TimeoutError"));

    await expect(pending).resolves.toMatchObject({
      events: [],
      outcome: "failed",
    });
    expect(fake.calls).toHaveLength(0);
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

  it("does not spawn a child when credentials return after the run signal was already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const spawnFn = vi.fn<OpenCodeSpawnFn>();
    const adapter = provider(spawnFn, {
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

      expect(spawnFn).not.toHaveBeenCalled();
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

  it("fails and terminates when supported records exceed the event cap", async () => {
    const fake = fakeSpawn(Array.from({ length: 481 }, (_, index) =>
      line("text", {
        part: {
          id: `supported_${index}`,
          type: "text",
          text: index === 480 ? "private overflow detail" : `chunk ${index}`,
          time: { end: index + 1 },
        },
      })
    ));

    const result = await provider(fake.spawnFn).startThread({
      principal, thread: thread(), request: request(), now: () => now, nextEventId: ids(),
    });

    expect(fake.kills).toContain("SIGTERM");
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "thread.error",
        error: expect.objectContaining({ code: "provider_run_failed", safeMessage: expect.any(String) }),
      }),
      expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
    ]));
    expect(result.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]));
    expect(JSON.stringify(result)).not.toContain("private overflow detail");
  });

  it("waits for stdout to drain after exit before classifying a cap-crossing tail", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const exit: Array<(code: number | null) => void> = [];
    const kills: NodeJS.Signals[] = [];
    const adapter = provider(() => {
      queueMicrotask(() => stdout.emit("data", Buffer.alloc(512 * 1024, "x")));
      queueMicrotask(() => exit.forEach((listener) => listener(0)));
      queueMicrotask(() => {
        stdout.emit("data", Buffer.alloc(512 * 1024 + 1, "x"));
        stdout.emit("end");
      });
      return {
        stdout,
        stderr,
        once(event: "exit" | "error", listener: never) {
          if (event === "exit") exit.push(listener);
        },
        kill(signal: NodeJS.Signals) { kills.push(signal); },
      };
    });

    const result = await adapter.startThread({
      principal,
      thread: thread(),
      request: request(),
      now: () => now,
      nextEventId: ids(),
    });

    expect(kills).toContain("SIGTERM");
    expect(result.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.error" }),
      expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
    ]));
    expect(result.events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "thread.completed", outcome: "completed" }),
    ]));
  });

  it("fails closed when stdout never drains after exit", async () => {
    vi.useFakeTimers();
    const exit: Array<(code: number | null) => void> = [];
    const adapter = provider(() => {
      queueMicrotask(() => exit.forEach((listener) => listener(0)));
      return {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        once(event: "exit" | "error", listener: never) {
          if (event === "exit") exit.push(listener);
        },
        kill: vi.fn(),
      };
    }, { runTimeoutMs: 1_000, killGraceMs: 10 });

    try {
      const pending = adapter.startThread({
        principal,
        thread: thread(),
        request: request(),
        now: () => now,
        nextEventId: ids(),
      });
      await vi.advanceTimersByTimeAsync(11);

      await expect(pending).resolves.toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "thread.completed", outcome: "failed" }),
        ]),
      });
    } finally {
      vi.useRealTimers();
    }
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

  it("reports the fixed owner-local OpenCode auth profile as authenticated without reading credentials", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "opencode-native-auth-"));
    const authDirectory = join(homePath, ".local", "share", "opencode");
    await mkdir(authDirectory, { recursive: true });
    await writeFile(join(authDirectory, "auth.json"), "{\"anthropic\":{}}\n", { mode: 0o600 });
    try {
      const runCommand = vi.fn(async () => ({ stdout: "1.16.0\n", stderr: "" }));
      const adapter = provider(fakeSpawn([]).spawnFn, { homePath, runCommand });
      await expect(adapter.getSummary!({ principal, now: () => now, signal: AbortSignal.timeout(1_000) }))
        .resolves.toMatchObject({
          availability: "available",
          installStatus: "installed",
          authStatus: "authenticated",
        });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
