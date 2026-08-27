import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";

class FakeStream extends EventEmitter {}

class FakeInput {
  readonly writes: Record<string, unknown>[] = [];
  ended = false;
  onRequest?: (request: Record<string, unknown>) => void;

  write(chunk: string | Buffer): boolean {
    const request = JSON.parse(chunk.toString().trim()) as Record<string, unknown>;
    this.writes.push(request);
    this.onRequest?.(request);
    return true;
  }

  end(): void {
    this.ended = true;
  }
}

class FakeGatewayChild extends EventEmitter {
  readonly stdin = new FakeInput();
  readonly stdout = new FakeStream();
  readonly stderr = new FakeStream();
  readonly kill = vi.fn((signal: NodeJS.Signals) => {
    if (signal === "SIGKILL" || !this.ignoreTerm) queueMicrotask(() => this.emit("exit", null, signal));
    return true;
  });
  ignoreTerm = false;

  frame(value: unknown): void {
    this.stdout.emit("data", Buffer.from(`${JSON.stringify(value)}\n`));
  }

  raw(value: string): void {
    this.stdout.emit("data", Buffer.from(value));
  }
}

function event(type: string, sessionId = "live_session", payload?: unknown) {
  return {
    jsonrpc: "2.0",
    method: "event",
    params: { type, session_id: sessionId, ...(payload === undefined ? {} : { payload }) },
  };
}

function result(request: Record<string, unknown>, value: unknown) {
  return { jsonrpc: "2.0", id: request.id, result: value };
}

function gatewayHarness(options: {
  storedSessionId?: string;
  wrongCreateResponseFirst?: boolean;
  ignoreTerm?: boolean;
  ignoreInterrupt?: boolean;
} = {}) {
  const child = new FakeGatewayChild();
  child.ignoreTerm = options.ignoreTerm ?? false;
  child.stdin.onRequest = (request) => {
    const method = request.method;
    if (method === "session.create") {
      if (options.wrongCreateResponseFirst) {
        child.frame({ jsonrpc: "2.0", id: "wrong-id", result: { session_id: "wrong", stored_session_id: "wrong" } });
      }
      queueMicrotask(() => child.frame(result(request, {
        session_id: "live_session",
        stored_session_id: options.storedSessionId ?? "stored_session",
      })));
    } else if (method === "session.resume") {
      queueMicrotask(() => child.frame(result(request, {
        session_id: "live_session",
        stored_session_id: options.storedSessionId ?? "stored_session",
      })));
    } else if (method === "config.set") {
      queueMicrotask(() => child.frame(result(request, { key: "yolo", value: "1", scope: "session" })));
    } else if (method === "prompt.submit") {
      queueMicrotask(() => child.frame(result(request, { status: "streaming" })));
    } else if (method === "session.interrupt") {
      if (!options.ignoreInterrupt) {
        queueMicrotask(() => child.frame(result(request, { status: "interrupted" })));
      }
    } else if (method === "session.close") {
      queueMicrotask(() => child.frame(result(request, { closed: true })));
    }
  };
  const spawnFn = vi.fn(() => {
    queueMicrotask(() => child.frame(event("gateway.ready", "", { change_events: true })));
    return child;
  });
  return { child, spawnFn };
}

const baseInput = {
  owner: { type: "personal" as const, ownerId: "owner_hermes" },
  chatId: "chat_hermes",
  turnId: "cturn_hermes",
  runId: "run_hermes",
  prompt: "hello",
  parts: [{ type: "text" as const, text: "hello" }],
  selection: { instanceId: "hermes_default", model: "openai-codex:gpt-5.6-luna" },
  interactionMode: "default",
  permissionMode: "full_access",
  executionRoot: "/safe/project",
  signal: new AbortController().signal,
};

async function waitForRequest(child: FakeGatewayChild, method: string) {
  await vi.waitFor(() => expect(child.stdin.writes.some((request) => request.method === method)).toBe(true));
  return child.stdin.writes.find((request) => request.method === method)!;
}

describe("Hermes canonical Chat Provider adapter", () => {
  it("streams two ordered stdio JSON-RPC deltas before the child Run completes", async () => {
    const { child, spawnFn } = gatewayHarness({ wrongCreateResponseFirst: true });
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = adapter.start(baseInput)[Symbol.asyncIterator]();

    const firstEvent = events.next();
    const promptRequest = await waitForRequest(child, "prompt.submit");
    child.frame(event("message.delta", "unrelated_session", { text: "ignore me" }));
    child.frame(event("message.delta", "live_session", { text: "hello " }));
    await expect(firstEvent).resolves.toMatchObject({ value: { type: "assistant.delta", delta: "hello " }, done: false });

    const secondEvent = events.next();
    child.frame(event("message.delta", "live_session", { text: "world" }));
    await expect(secondEvent).resolves.toMatchObject({ value: { type: "assistant.delta", delta: "world" }, done: false });

    expect(child.kill).not.toHaveBeenCalled();
    expect(promptRequest.params).toEqual({ session_id: "live_session", text: "hello" });
    const createRequest = child.stdin.writes.find((request) => request.method === "session.create")!;
    expect(createRequest.params).toMatchObject({
      cwd: "/safe/project",
      provider: "openai-codex",
      model: "gpt-5.6-luna",
      source: "desktop",
    });
    expect(child.stdin.writes.find((request) => request.method === "config.set")?.params).toEqual({
      key: "yolo",
      value: "1",
      scope: "session",
      session_id: "live_session",
    });
    expect(spawnFn).toHaveBeenCalledWith(
      "/home/matrix/home/.hermes/hermes-agent/venv/bin/python",
      ["-u", "-m", "tui_gateway.entry"],
      expect.objectContaining({ cwd: "/safe/project", stdio: ["pipe", "pipe", "pipe"] }),
    );

    child.frame(event("message.complete", "live_session", { text: "hello world", status: "success" }));
    await expect(events.next()).resolves.toMatchObject({ value: { type: "state.updated", state: { sessionId: "stored_session" } } });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "run.completed", outcome: "completed" } });
    await expect(events.next()).resolves.toMatchObject({ done: true });
  });

  it("resumes only the durable stored session while preserving its stored provider selection", async () => {
    const { child, spawnFn } = gatewayHarness({ storedSessionId: "stored_session" });
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = adapter.resume!({ ...baseInput, resumeState: { sessionId: "stored_session" } })[Symbol.asyncIterator]();
    const first = events.next();
    await waitForRequest(child, "prompt.submit");

    const resumeRequest = child.stdin.writes.find((request) => request.method === "session.resume")!;
    expect(resumeRequest.params).toEqual({ session_id: "stored_session", cols: 120, omit_messages: true });
    expect(child.stdin.writes.some((request) => request.method === "session.create")).toBe(false);
    child.frame(event("message.delta", "live_session", { text: "continued" }));
    await expect(first).resolves.toMatchObject({ value: { type: "assistant.delta", delta: "continued" } });
    child.frame(event("message.complete", "live_session", { text: "continued", status: "success" }));
    await expect(events.next()).resolves.toMatchObject({ value: { type: "run.completed", outcome: "completed" } });
    await expect(events.next()).resolves.toMatchObject({ done: true });
  });

  it("reconciles a missing trailing delta from the authoritative completion text", async () => {
    const { child, spawnFn } = gatewayHarness();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = adapter.start(baseInput)[Symbol.asyncIterator]();
    const first = events.next();
    await waitForRequest(child, "prompt.submit");

    child.frame(event("message.delta", "live_session", { text: "hello " }));
    await expect(first).resolves.toMatchObject({ value: { type: "assistant.delta", delta: "hello " } });
    child.frame(event("message.complete", "live_session", { text: "hello world", status: "success" }));

    await expect(events.next()).resolves.toMatchObject({ value: { type: "assistant.delta", delta: "world" } });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "state.updated" } });
    await expect(events.next()).resolves.toMatchObject({ value: { type: "run.completed", outcome: "completed" } });
    await expect(events.next()).resolves.toMatchObject({ done: true });
  });

  it("clears shutdown timers after a clean child exit", async () => {
    vi.useFakeTimers();
    try {
      const { child, spawnFn } = gatewayHarness();
      const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
      const events = adapter.start(baseInput)[Symbol.asyncIterator]();
      const first = events.next();
      await vi.advanceTimersByTimeAsync(0);
      child.frame(event("message.delta", "live_session", { text: "done" }));
      await expect(first).resolves.toMatchObject({ value: { type: "assistant.delta", delta: "done" } });
      child.frame(event("message.complete", "live_session", { text: "done", status: "success" }));

      await expect(events.next()).resolves.toMatchObject({ value: { type: "state.updated" } });
      await expect(events.next()).resolves.toMatchObject({ value: { type: "run.completed" } });
      await expect(events.next()).resolves.toMatchObject({ done: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("interrupts the live Hermes session on abort before terminating its child", async () => {
    const controller = new AbortController();
    const { child, spawnFn } = gatewayHarness();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
    const events = adapter.start({ ...baseInput, signal: controller.signal })[Symbol.asyncIterator]();
    const terminal = events.next();
    await waitForRequest(child, "prompt.submit");
    controller.abort();

    await expect(terminal).resolves.toMatchObject({ value: { type: "run.completed", outcome: "aborted" } });
    expect(child.stdin.writes.find((request) => request.method === "session.interrupt")?.params).toEqual({ session_id: "live_session" });
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds an unresponsive session interrupt before terminating the child", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    try {
      const { child, spawnFn } = gatewayHarness({ ignoreInterrupt: true });
      const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });
      const events = adapter.start({ ...baseInput, signal: controller.signal })[Symbol.asyncIterator]();
      let terminalSettled = false;
      const terminal = events.next().then((value) => {
        terminalSettled = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(child.stdin.writes.some((request) => request.method === "prompt.submit")).toBe(true);

      controller.abort();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(terminalSettled).toBe(true);
      await expect(terminal).resolves.toMatchObject({ value: { type: "run.completed", outcome: "aborted" } });
      expect(child.stdin.writes.some((request) => request.method === "session.interrupt")).toBe(true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      await expect(events.next()).resolves.toMatchObject({ done: true });
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  });

  it.each([
    ["malformed", (child: FakeGatewayChild) => child.raw("not-json\n")],
    ["oversized", (child: FakeGatewayChild) => child.raw(`${"x".repeat(257)}\n`)],
    ["stderr overflow", (child: FakeGatewayChild) => child.stderr.emit("data", Buffer.alloc(257))],
  ])("fails safely for %s child output", async (_name, corrupt) => {
    const { child, spawnFn } = gatewayHarness();
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn,
      maxFrameBytes: 256,
      maxStderrBytes: 256,
    });
    const events = adapter.start(baseInput)[Symbol.asyncIterator]();
    const terminal = events.next();
    await waitForRequest(child, "prompt.submit");
    corrupt(child);

    await expect(terminal).resolves.toMatchObject({
      value: {
        type: "run.completed",
        outcome: "failed",
        error: {
          code: "run_failed",
          safeMessage: "Hermes could not complete this Run. Check its provider connection and retry.",
        },
      },
    });
    await expect(events.next()).resolves.toMatchObject({ done: true });
  });

  it.each([
    ["assistant output cap", { maxOutputBytes: 5 }, event("message.delta", "live_session", { text: "secret-output" })],
    ["provider terminal error", {}, event("message.complete", "live_session", {
      status: "error",
      text: "partial",
      error: "private provider credential and path",
    })],
  ])("returns only the bounded generic error for %s", async (_name, limits, failureFrame) => {
    const { child, spawnFn } = gatewayHarness();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn, ...limits });
    const events = adapter.start(baseInput)[Symbol.asyncIterator]();
    const terminal = events.next();
    await waitForRequest(child, "prompt.submit");
    child.frame(failureFrame);

    const result = await terminal;
    expect(result).toMatchObject({
      value: {
        type: "run.completed",
        outcome: "failed",
        error: {
          code: "run_failed",
          safeMessage: "Hermes could not complete this Run. Check its provider connection and retry.",
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("credential");
    await expect(events.next()).resolves.toMatchObject({ done: true });
  });

  it.each([
    ["startup", { startupTimeoutMs: 10, stallTimeoutMs: 1_000, totalTimeoutMs: 1_000 }, false],
    ["stall", { startupTimeoutMs: 1_000, stallTimeoutMs: 10, totalTimeoutMs: 1_000 }, true],
    ["total", { startupTimeoutMs: 1_000, stallTimeoutMs: 1_000, totalTimeoutMs: 10 }, true],
  ])("bounds %s waits and escalates SIGTERM to SIGKILL", async (_name, timeouts, sendReady) => {
    const child = new FakeGatewayChild();
    child.ignoreTerm = true;
    const spawnFn = vi.fn(() => {
      if (sendReady) queueMicrotask(() => child.frame(event("gateway.ready", "", {})));
      return child;
    });
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn,
      terminationGraceMs: 5,
      forceSettleMs: 5,
      ...timeouts,
    });
    const events = adapter.start(baseInput)[Symbol.asyncIterator]();

    await expect(events.next()).resolves.toMatchObject({ value: { type: "run.completed", outcome: "failed" } });
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  });

  it("bounds a synchronous child spawn failure behind the generic provider error", async () => {
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: () => {
        throw new Error("private executable path");
      },
    });
    const events = adapter.start(baseInput)[Symbol.asyncIterator]();

    await expect(events.next()).resolves.toMatchObject({
      value: {
        type: "run.completed",
        outcome: "failed",
        error: {
          code: "run_failed",
          safeMessage: "Hermes could not complete this Run. Check its provider connection and retry.",
        },
      },
    });
    await expect(events.next()).resolves.toMatchObject({ done: true });
  });

  it("rejects unsupported permission and malformed provider selections before spawn", async () => {
    const spawnFn = vi.fn(() => new FakeGatewayChild());
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn });

    await expect(async () => {
      for await (const _event of adapter.start({ ...baseInput, permissionMode: "supervised" })) {}
    }).rejects.toThrow("Unsupported Hermes permission mode");
    await expect(async () => {
      for await (const _event of adapter.start({
        ...baseInput,
        selection: { instanceId: "hermes_default", model: "missing-separator" },
      })) {}
    }).rejects.toThrow("Unsupported Hermes model selection");
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
