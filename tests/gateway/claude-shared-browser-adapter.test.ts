import { ownerSdkAdapterFixture } from "./owner-sdk-home-test-support.js";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalCliSpawn } from "../../packages/gateway/src/chat/cli-process.js";
import { createMatrixMcpCapabilityRegistry } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import type { CustomMcpApprovalClient } from "../../packages/gateway/src/chat/custom-mcp-approval-client.js";

const createClaudeChatProviderAdapter = ownerSdkAdapterFixture();

class FakeStream extends EventEmitter {}

afterEach(() => vi.unstubAllEnvs());

function child(lines: string[], exitCode = 0, stderrLines: string[] = []) {
  const stdout = new FakeStream();
  const stderr = new FakeStream();
  const process = new EventEmitter() as EventEmitter & {
    stdout: FakeStream;
    stderr: FakeStream;
    kill: ReturnType<typeof vi.fn>;
  };
  Object.assign(process, { stdin: { write: (_chunk: string, callback?: (error?: Error | null) => void) => { callback?.(); return true; } } });
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

describe("Claude same Chrome execution", () => {
  it("injects the same Chrome lease only for full-access personal default Runs and revokes on terminal exit", async () => {
    const { createSharedBrowserBroker } = await import("../../packages/gateway/src/shared-browser/broker.js");
    const broker = createSharedBrowserBroker({ ownerId: "owner_claude", driver: { execute: async () => ({ success: true }), detach: async () => {}, invalidateObservation() {} }, setHumanControl: async () => {} });
    const spawnFn = vi.fn<CanonicalCliSpawn>(() => child([JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "native_session" })]));
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", sharedBrowser: broker, sharedBrowserGatewayPort: 4321, spawnFn });
    const full = { ...baseInput, permissionMode: "full_access" };
    try {
      for await (const _ of adapter.start(full)) {}
      const options = spawnFn.mock.calls[0]![2];
      const token = options.env!.MATRIX_SHARED_BROWSER_TOKEN!;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(options.env!.MATRIX_SHARED_BROWSER_GATEWAY_PORT).toBe("4321");
      const args = spawnFn.mock.calls[0]![1];
      expect(args).toContain("--strict-mcp-config"); expect(args).toContain("--no-chrome");
      expect(args.join(" ")).not.toContain(token);
      expect(JSON.parse(args[args.indexOf("--mcp-config") + 1]!).mcpServers).toHaveProperty("matrix_shared_browser");
      expect(broker.resolveCapability(token)).toBeNull();
      for (const patch of [{ permissionMode: "supervised" }, { interactionMode: "review" }, { sharedScopeId: "shared" }]) {
        for await (const _ of adapter.start({ ...full, ...patch })) {}
        expect(spawnFn.mock.calls.at(-1)![2].env).not.toHaveProperty("MATRIX_SHARED_BROWSER_TOKEN");
      }
    } finally { await broker.close(); }
  });
  it("revokes browser authority when credential preflight fails", async () => {
    const { createSharedBrowserBroker } = await import("../../packages/gateway/src/shared-browser/broker.js");
    const broker = createSharedBrowserBroker({ ownerId: "owner_claude", driver: { execute: async () => ({ success: true }), detach: async () => {}, invalidateObservation() {} }, setHumanControl: async () => {} });
    const open = vi.spyOn(broker, "openRun");
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", sharedBrowser: broker, resolveCredentialLaunch: async () => { throw new Error("test credential unavailable"); } });
    try {
      await expect(async () => { for await (const _ of adapter.start({ ...baseInput, permissionMode: "full_access" })) {} }).rejects.toThrow();
      expect(open).toHaveBeenCalledOnce(); expect(broker.resolveCapability(open.mock.results[0]!.value.token)).toBeNull();
    } finally { await broker.close(); }
  });


  it("drains the old Chrome lease before Steer starts a fresh native execution", async () => {
    const { createSharedBrowserBroker } = await import("../../packages/gateway/src/shared-browser/broker.js");
    let finishDetach!: () => void;
    const detach = vi.fn(async () => {}).mockImplementationOnce(() => new Promise<void>(resolve => { finishDetach = resolve; }));
    const broker = createSharedBrowserBroker({ ownerId: "owner_claude", driver: { execute: async () => ({ success: true, observationId: "obs", content: "Page" }), detach, invalidateObservation() {} }, setHumanControl: async () => {} });
    const first = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; kill: ReturnType<typeof vi.fn> };
    Object.assign(first, { stdin: { write: (_frame: string, callback?: () => void) => { callback?.(); return true; } }, stdout: new FakeStream(), stderr: new FakeStream(), kill: vi.fn(() => queueMicrotask(() => first.emit("exit", null, "SIGTERM"))) });
    const tokens: string[] = [];
    const spawnFn = vi.fn<CanonicalCliSpawn>().mockImplementationOnce((_command, _args, options) => {
      const token = options.env.MATRIX_SHARED_BROWSER_TOKEN!; tokens.push(token);
      const binding = broker.resolveCapability(token)!;
      void broker.execute(binding, { action: "snapshot" }, new AbortController().signal).then(() => first.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "init", session_id: "native_steer" }) + "\n")));
      return first;
    }).mockImplementationOnce((_command, _args, options) => {
      tokens.push(options.env.MATRIX_SHARED_BROWSER_TOKEN!);
      expect(broker.resolveCapability(tokens[0]!)).toBeNull();
      expect(broker.resolveCapability(tokens[1]!)).not.toBeNull();
      return child([JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "native_steer" })]);
    });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", sharedBrowser: broker, spawnFn });
    const events: unknown[] = [];
    const running = (async () => { for await (const event of adapter.start({ ...baseInput, permissionMode: "full_access" })) events.push(event); })();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "state.updated" })));
    await adapter.steer!({ owner: baseInput.owner, chatId: baseInput.chatId, runId: baseInput.runId, turnId: baseInput.turnId, prompt: "Continue", parts: [{ type: "text", text: "Continue" }], clientRequestId: "steer-browser" });
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
    expect(broker.resolveCapability(tokens[0]!)).toBeNull(); expect(spawnFn).toHaveBeenCalledOnce();
    finishDetach(); await running;
    expect(tokens[1]).not.toBe(tokens[0]); expect(spawnFn).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    await broker.close();
  });

  it("finishes the outer stream with the replacement's cleanup failure after Steer", async () => {
    const { createSharedBrowserBroker } = await import("../../packages/gateway/src/shared-browser/broker.js");
    const detach = vi.fn(async () => {}).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      throw new Error("Synthetic replacement detach refusal");
    });
    const broker = createSharedBrowserBroker({ ownerId: "owner_claude",
      driver: { execute: async () => ({ success: true, observationId: "obs", content: "Page" }), detach, invalidateObservation() {} },
      setHumanControl: async () => {},
    });
    const first = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; kill: ReturnType<typeof vi.fn> };
    Object.assign(first, { stdin: { write: (_frame: string, callback?: () => void) => { callback?.(); return true; } },
      stdout: new FakeStream(), stderr: new FakeStream(), kill: vi.fn(() => queueMicrotask(() => first.emit("exit", null, "SIGTERM"))),
    });
    const tokens: string[] = [];
    const spawnFn = vi.fn<CanonicalCliSpawn>((_command, _args, options) => {
      const token = options.env.MATRIX_SHARED_BROWSER_TOKEN!; tokens.push(token);
      const native = tokens.length === 1 ? first : Object.assign(new EventEmitter(), {
        stdin: { write: (_frame: string, callback?: () => void) => { callback?.(); return true; } },
        stdout: new FakeStream(), stderr: new FakeStream(), kill: vi.fn(),
      });
      void broker.execute(broker.resolveCapability(token)!, { action: "snapshot" }, new AbortController().signal).then(() => {
        native.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "init", session_id: "native_replacement" }) + "\n"));
        if (tokens.length === 2) {
          native.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "native_replacement" }) + "\n"));
          native.emit("exit", 0, null);
        }
      });
      return native;
    });
    const onCleanupUnconfirmed = vi.fn();
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", sharedBrowser: broker, spawnFn });
    const events: unknown[] = [];
    const settled = (async () => { for await (const event of adapter.start({ ...baseInput, permissionMode: "full_access", onCleanupUnconfirmed })) events.push(event); })()
      .then(() => ({ kind: "completed" as const }), (error: unknown) => ({ kind: "failed" as const, error }));
    try {
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "state.updated" })));
      await adapter.steer!({ owner: baseInput.owner, chatId: baseInput.chatId, runId: baseInput.runId, turnId: baseInput.turnId,
        prompt: "Continue", parts: [{ type: "text", text: "Continue" }], clientRequestId: "steer-replacement-cleanup" });
      const result = await Promise.race([settled, new Promise<{ kind: "timeout" }>(resolve => setTimeout(() => resolve({ kind: "timeout" }), 500))]);
      expect(result.kind).toBe("failed");
      if (result.kind === "failed") expect(result.error).toEqual(new Error("Browser cleanup unconfirmed"));
      expect(onCleanupUnconfirmed).toHaveBeenCalledOnce();
      expect(tokens).toHaveLength(2);
      expect(tokens.map(token => broker.resolveCapability(token))).toEqual([null, null]);
      expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "completed" });
    } finally { await broker.close(); }
  });

  it("revokes browser authority immediately when the owner cancels the native Run", async () => {
    const { createSharedBrowserBroker } = await import("../../packages/gateway/src/shared-browser/broker.js");
    const broker = createSharedBrowserBroker({ ownerId: "owner_claude", driver: { execute: async () => ({ success: true }), detach: async () => {}, invalidateObservation() {} }, setHumanControl: async () => {} });
    const native = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; kill: ReturnType<typeof vi.fn> };
    Object.assign(native, { stdin: { write: (_frame: string, callback?: () => void) => { callback?.(); return true; } }, stdout: new FakeStream(), stderr: new FakeStream(), kill: vi.fn(() => queueMicrotask(() => native.emit("exit", null, "SIGTERM"))) });
    let token = "";
    const spawnFn = vi.fn<CanonicalCliSpawn>((_command, _args, options) => { token = options.env.MATRIX_SHARED_BROWSER_TOKEN!; queueMicrotask(() => native.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "init", session_id: "native_cancel" }) + "\n"))); return native; });
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", sharedBrowser: broker, spawnFn });
    const events: unknown[] = [];
    const running = (async () => { for await (const event of adapter.start({ ...baseInput, permissionMode: "full_access" })) events.push(event); })();
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "state.updated" })));
    expect(broker.resolveCapability(token)).not.toBeNull();
    await adapter.cancel!({ owner: baseInput.owner, chatId: baseInput.chatId, runId: baseInput.runId });
    expect(broker.resolveCapability(token)).toBeNull(); await running;
    expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: "aborted" });
    expect(JSON.stringify(events)).not.toContain(token); await broker.close();
  });

  it.each(["completed", "cancelled", "steered"])("throws after %s when the browser detach is physically unconfirmed", async (outcome) => {
    const { createSharedBrowserBroker } = await import("../../packages/gateway/src/shared-browser/broker.js");
    const detach = vi.fn(async () => { throw new Error("Synthetic detach refusal"); });
    const broker = createSharedBrowserBroker({ ownerId: "owner_claude",
      driver: { execute: async () => ({ success: true, observationId: "obs", content: "Page" }), detach, invalidateObservation() {} },
      setHumanControl: async () => {},
    });
    const native = new EventEmitter() as EventEmitter & { stdout: FakeStream; stderr: FakeStream; kill: ReturnType<typeof vi.fn> };
    Object.assign(native, { stdin: { write: (_frame: string, callback?: () => void) => { callback?.(); return true; } },
      stdout: new FakeStream(), stderr: new FakeStream(), kill: vi.fn(() => queueMicrotask(() => native.emit("exit", null, "SIGTERM"))),
    });
    let token = "";
    const spawnFn = vi.fn<CanonicalCliSpawn>((_command, _args, options) => {
      token = options.env.MATRIX_SHARED_BROWSER_TOKEN!;
      void broker.execute(broker.resolveCapability(token)!, { action: "snapshot" }, new AbortController().signal).then(() => {
        native.stdout.emit("data", Buffer.from(JSON.stringify({ type: "system", subtype: "init", session_id: "native_unconfirmed" }) + "\n"));
        if (outcome === "completed") {
          native.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", session_id: "native_unconfirmed" }) + "\n"));
          native.emit("exit", 0, null);
        }
      });
      return native;
    });
    const onCleanupUnconfirmed = vi.fn();
    const adapter = createClaudeChatProviderAdapter({ homePath: "/home/matrix/home", sharedBrowser: broker, spawnFn });
    const events: unknown[] = [];
    const running = (async () => {
      for await (const event of adapter.start({ ...baseInput, permissionMode: "full_access", onCleanupUnconfirmed })) events.push(event);
    })();
    const rejected = expect(running).rejects.toThrow("Browser cleanup unconfirmed");
    try {
      if (outcome !== "completed") {
        await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: "state.updated" })));
        if (outcome === "cancelled") await adapter.cancel!({ owner: baseInput.owner, chatId: baseInput.chatId, runId: baseInput.runId });
        else await adapter.steer!({ owner: baseInput.owner, chatId: baseInput.chatId, runId: baseInput.runId,
          turnId: baseInput.turnId, prompt: "Continue", parts: [{ type: "text", text: "Continue" }], clientRequestId: "steer-unconfirmed" });
      }
      await rejected;
      expect(onCleanupUnconfirmed).toHaveBeenCalledOnce();
      expect(detach).toHaveBeenCalledOnce();
      expect(broker.resolveCapability(token)).toBeNull();
      expect(spawnFn).toHaveBeenCalledOnce();
      expect(events.at(-1)).toMatchObject({ type: "run.completed", outcome: outcome === "completed" ? "completed" : outcome === "cancelled" ? "aborted" : "failed" });
    } finally { await broker.close(); }
  });

});
