import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createHermesChatProviderAdapter } from "../../packages/gateway/src/chat/hermes-provider-adapter.js";
import type {
  HermesGatewayProcess,
  HermesGatewaySpawn,
} from "../../packages/gateway/src/chat/hermes-stdio-client.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

class FakeStream extends EventEmitter {}

function fakeGateway(options: { emitReady?: boolean; ignoreMethods?: readonly string[] } = {}) {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const emitter = new EventEmitter();
  const requests: RpcRequest[] = [];
  const send = (frame: unknown) => stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  const respond = (request: RpcRequest, result: unknown) => send({ jsonrpc: "2.0", id: request.id, result });
  const stdin = {
    write: vi.fn((chunk: string) => {
      for (const line of chunk.trim().split("\n")) {
        const request = JSON.parse(line) as RpcRequest;
        requests.push(request);
        if (options.ignoreMethods?.includes(request.method)) continue;
        queueMicrotask(() => {
          if (request.method === "session.create") {
            respond(request, { session_id: "live_session", stored_session_id: "durable_session" });
          } else if (request.method === "session.resume") {
            respond(request, { session_id: "live_session", session_key: request.params.session_id });
          } else if (request.method === "prompt.submit") {
            respond(request, { status: "streaming" });
          } else if (request.method === "session.interrupt") {
            respond(request, { status: "interrupted" });
          } else if (request.method === "config.set" && request.params.key === "yolo") {
            respond(request, { key: "yolo", value: "1", scope: "session" });
          } else if (request.method === "config.set" && request.params.key === "model") {
            respond(request, { key: "model", value: request.params.value, confirm_required: false });
          } else if (request.method === "session.cwd.set") {
            respond(request, { cwd: request.params.cwd });
          } else {
            respond(request, {});
          }
        });
      }
      return true;
    }),
    end: vi.fn(() => queueMicrotask(() => emitter.emit("exit", 0, null))),
  };
  const kill = vi.fn((signal: NodeJS.Signals) => queueMicrotask(() => emitter.emit("exit", null, signal)));
  const process = Object.assign(emitter, { stdin, stdout, stderr, kill }) as unknown as HermesGatewayProcess;
  const spawnFn = vi.fn<HermesGatewaySpawn>(() => {
    if (options.emitReady !== false) {
      queueMicrotask(() => send({
        jsonrpc: "2.0",
        method: "event",
        params: { type: "gateway.ready", payload: { change_events: true } },
      }));
    }
    return process;
  });
  return {
    process,
    requests,
    spawnFn,
    sendRaw(value: string) {
      stdout.emit("data", Buffer.from(value));
    },
    event(type: string, payload: unknown, sessionId = "live_session") {
      send({
        jsonrpc: "2.0",
        method: "event",
        params: { type, session_id: sessionId, payload },
      });
    },
  };
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

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Hermes canonical Chat Provider adapter", () => {
  it("forwards namespaced model ids to Hermes without rewriting them", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
    });
    const eventsPromise = collect(adapter.start({
      ...baseInput,
      selection: {
        instanceId: "hermes_default",
        model: "nous:anthropic/claude-opus-5",
      },
    }));

    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));
    expect(gateway.requests.find(({ method }) => method === "session.create")?.params)
      .toMatchObject({ provider: "nous", model: "anthropic/claude-opus-5" });

    gateway.event("message.complete", { text: "", status: "complete" });
    await expect(eventsPromise).resolves.toEqual(expect.arrayContaining([
      { type: "run.completed", outcome: "completed" },
    ]));
  });

  it("yields assistant text before the Hermes process completes", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
    });
    const iterator = adapter.start(baseInput)[Symbol.asyncIterator]();
    const firstEvent = iterator.next();
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));

    gateway.event("message.delta", { text: "first live fragment" });
    const observed = await Promise.race([
      firstEvent,
      new Promise<"not-streamed">((resolve) => setTimeout(() => resolve("not-streamed"), 50)),
    ]);

    expect(observed).toEqual({
      done: false,
      value: { type: "assistant.delta", delta: "first live fragment" },
    });
    expect(gateway.process.kill).not.toHaveBeenCalled();
    gateway.event("message.complete", { text: "first live fragment", status: "complete" });
    const remaining = [];
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      remaining.push(next.value);
    }
    expect(remaining).toEqual([
      { type: "state.updated", state: { sessionId: "durable_session" } },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("coalesces fine-grained Hermes deltas below the canonical activity limit", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
    });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));

    const response = "x".repeat(600);
    for (const character of response) {
      gateway.event("message.delta", { text: character });
    }
    gateway.event("message.complete", { text: response, status: "complete" });

    const events = await eventsPromise;
    const deltas = events.filter((event): event is { type: "assistant.delta"; delta: string } => (
      typeof event === "object" && event !== null && (event as { type?: unknown }).type === "assistant.delta"
    ));
    expect(deltas.map(({ delta }) => delta).join("")).toBe(response);
    expect(deltas.length).toBeLessThan(100);
    expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  });

  it("ignores global Hermes advisory events with an empty session id", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
    });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));

    gateway.event("sessions.changed", {}, "");
    gateway.event("message.delta", { text: "still streaming" });
    gateway.event("message.complete", { text: "still streaming", status: "complete" });

    expect(await eventsPromise).toEqual([
      { type: "assistant.delta", delta: "still streaming" },
      { type: "state.updated", state: { sessionId: "durable_session" } },
      { type: "run.completed", outcome: "completed" },
    ]);
    expect(gateway.process.kill).not.toHaveBeenCalled();
  });

  it("starts the official Hermes stdio gateway with the selected provider, model, and root", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
    });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));
    gateway.event("message.delta", { text: "hello " });
    gateway.event("message.delta", { text: "from hermes" });
    gateway.event("message.complete", { text: "hello from hermes", status: "complete" });

    expect(await eventsPromise).toEqual([
      { type: "assistant.delta", delta: "hello " },
      { type: "assistant.delta", delta: "from hermes" },
      { type: "state.updated", state: { sessionId: "durable_session" } },
      { type: "run.completed", outcome: "completed" },
    ]);
    const [command, args, options] = gateway.spawnFn.mock.calls[0]!;
    expect(command).toBe("/home/matrix/home/.hermes/hermes-agent/venv/bin/python");
    expect(args).toEqual(["-u", "-m", "tui_gateway.entry"]);
    expect(options).toMatchObject({
      cwd: "/safe/project",
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        HOME: "/home/matrix/home",
        MATRIX_HOME: "/home/matrix/home",
        HERMES_PYTHON_SRC_ROOT: "/home/matrix/home/.hermes/hermes-agent",
        PYTHONPATH: "/home/matrix/home/.hermes/hermes-agent",
        PYTHONUNBUFFERED: "1",
      },
    });
    expect(gateway.requests).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "session.create",
        params: expect.objectContaining({
          cwd: "/safe/project",
          provider: "openai-codex",
          model: "gpt-5.6-luna",
          source: "matrix-os-desktop",
        }),
      }),
      expect.objectContaining({
        method: "session.cwd.set",
        params: { session_id: "live_session", cwd: "/safe/project" },
      }),
      expect.objectContaining({
        method: "config.set",
        params: { session_id: "live_session", key: "yolo", value: "1", scope: "session" },
      }),
      expect.objectContaining({
        method: "prompt.submit",
        params: { session_id: "live_session", text: "hello", surface: "desktop" },
      }),
    ]));
  });

  it("resumes only the persisted Hermes session in a fresh gateway process", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
    });
    const eventsPromise = collect(adapter.resume!({
      ...baseInput,
      resumeState: { sessionId: "durable_session" },
    }));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));
    gateway.event("message.delta", { text: "continued" });
    gateway.event("message.complete", { text: "continued", status: "complete" });

    expect(await eventsPromise).toEqual([
      { type: "assistant.delta", delta: "continued" },
      { type: "run.completed", outcome: "completed" },
    ]);
    expect(gateway.requests.find(({ method }) => method === "session.resume")?.params).toMatchObject({
      session_id: "durable_session",
      cwd: "/safe/project",
      omit_messages: true,
    });
    expect(gateway.requests).toContainEqual(expect.objectContaining({
      method: "config.set",
      params: {
        session_id: "live_session",
        key: "model",
        value: "gpt-5.6-luna --provider openai-codex --session",
        confirm_expensive_model: true,
      },
    }));
    expect(gateway.requests.some(({ method }) => method === "session.create")).toBe(false);
  });

  it("reconciles an authoritative completion tail without duplicating streamed text", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));
    gateway.event("message.delta", { text: "streamed" });
    gateway.event("message.complete", { text: "streamed tail", status: "complete" });

    expect(await eventsPromise).toEqual([
      { type: "assistant.delta", delta: "streamed" },
      { type: "assistant.delta", delta: " tail" },
      { type: "state.updated", state: { sessionId: "durable_session" } },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("preserves an interim Hermes segment before streaming the final segment", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));
    gateway.event("message.delta", { text: "interim answer" });
    gateway.event("message.interim", { text: "interim answer", already_streamed: true });
    gateway.event("message.delta", { text: "final answer" });
    gateway.event("message.complete", { text: "final answer", status: "complete" });

    expect(await eventsPromise).toEqual([
      { type: "assistant.delta", delta: "interim answer" },
      { type: "assistant.delta", delta: "\n\nfinal answer" },
      { type: "state.updated", state: { sessionId: "durable_session" } },
      { type: "run.completed", outcome: "completed" },
    ]);
  });

  it("interrupts the live Hermes session before closing an aborted Run", async () => {
    const gateway = fakeGateway();
    const abortController = new AbortController();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
    const eventsPromise = collect(adapter.start({ ...baseInput, signal: abortController.signal }));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));

    abortController.abort();

    expect(await eventsPromise).toEqual([{ type: "run.completed", outcome: "aborted" }]);
    expect(gateway.requests).toContainEqual(expect.objectContaining({
      method: "session.interrupt",
      params: { session_id: "live_session" },
    }));
    expect(gateway.process.stdin.end).toHaveBeenCalledOnce();
  });

  it("fails safely when Hermes returns malformed protocol data", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));

    gateway.sendRaw("not-json\n");

    expect(await eventsPromise).toEqual([{
      type: "run.completed",
      outcome: "failed",
      error: {
        code: "run_failed",
        safeMessage: "The selected provider could not complete this Run. Check its connection and retry.",
        retryable: true,
        recoveryActions: ["retry"],
      },
    }]);
    expect(gateway.process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("fails closed when the final response diverges from already streamed text", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));
    gateway.event("message.delta", { text: "visible partial" });
    gateway.event("message.complete", { text: "different final", status: "complete" });

    expect(await eventsPromise).toEqual([
      { type: "assistant.delta", delta: "visible partial" },
      expect.objectContaining({ type: "run.completed", outcome: "failed" }),
    ]);
  });

  it("caps streamed Hermes output before it can grow adapter memory without bound", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });
    const eventsPromise = collect(adapter.start(baseInput));
    await vi.waitFor(() => expect(gateway.requests.some(({ method }) => method === "prompt.submit")).toBe(true));
    gateway.event("message.delta", { text: "x".repeat(96 * 1024 + 1) });

    expect(await eventsPromise).toEqual([
      expect.objectContaining({ type: "run.completed", outcome: "failed" }),
    ]);
    expect(gateway.process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("bounds gateway startup instead of waiting forever for a ready frame", async () => {
    const gateway = fakeGateway({ emitReady: false });
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
      readyTimeoutMs: 5,
    });

    expect(await collect(adapter.start(baseInput))).toEqual([
      expect.objectContaining({ type: "run.completed", outcome: "failed" }),
    ]);
    expect(gateway.process.kill).toHaveBeenCalledWith("SIGTERM");
    expect(gateway.requests).toEqual([]);
  });

  it("bounds JSON-RPC requests instead of waiting forever for a response", async () => {
    const gateway = fakeGateway({ ignoreMethods: ["session.create"] });
    const adapter = createHermesChatProviderAdapter({
      homePath: "/home/matrix/home",
      spawnFn: gateway.spawnFn,
      requestTimeoutMs: 5,
    });

    expect(await collect(adapter.start(baseInput))).toEqual([
      expect.objectContaining({ type: "run.completed", outcome: "failed" }),
    ]);
    expect(gateway.requests.map(({ method }) => method)).toEqual(["session.create"]);
    expect(gateway.process.stdin.end).toHaveBeenCalledOnce();
  });

  it("rejects unsupported permission and malformed provider selections before spawn", async () => {
    const gateway = fakeGateway();
    const adapter = createHermesChatProviderAdapter({ homePath: "/home/matrix/home", spawnFn: gateway.spawnFn });

    await expect(async () => {
      for await (const _event of adapter.start({ ...baseInput, permissionMode: "supervised" })) {}
    }).rejects.toThrow("Unsupported Hermes permission mode");
    await expect(async () => {
      for await (const _event of adapter.start({
        ...baseInput,
        selection: { instanceId: "hermes_default", model: "missing-separator" },
      })) {}
    }).rejects.toThrow("Unsupported Hermes model selection");
    expect(gateway.spawnFn).not.toHaveBeenCalled();
  });
});
