import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexEventBridge, codexProviderEventPath } from "../../packages/gateway/src/coding-agents/codex-event-bridge.js";
import { CODEX_VERIFIED_VERSION } from "@matrix-os/contracts";

describe("Codex runtime supervision", () => {
  async function fixture(probe: () => Promise<boolean>) {
    const homePath = await mkdtemp(join(tmpdir(), "codex-supervision-"));
    let now = 0;
    const ingestProviderEvents = vi.fn(async (..._args: unknown[]) => ({}));
    const bridge = createCodexEventBridge({ homePath, nowMs: () => now, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }),
      isRuntimeAlive: probe,
    });
    bridge.attachThreadStore({ ingestProviderEvents });
    const watch = (startAtEnd = false) => bridge.watch({ principal: { userId: "owner", source: "jwt" },
      threadId: "thread_test", sessionId: "sess_test", startAtEnd });
    await watch();
    return { bridge, ingestProviderEvents, watch, path: codexProviderEventPath(homePath, "sess_test"),
      tick: async (time: number) => { now = time; await bridge.drain(); },
      close: async () => { await bridge.shutdown(); await rm(homePath, { recursive: true, force: true }); },
    };
  }

  it.each(["not json\n", '{"type":']) ("does not let malformed or partial output hide startup failure: %s", async (bytes) => {
    const f = await fixture(async () => true);
    try {
      await writeFile(f.path, bytes);
      await f.tick(61_000);
      expect(f.ingestProviderEvents).toHaveBeenCalledWith(expect.anything(), "thread_test", expect.objectContaining({
        events: expect.arrayContaining([expect.objectContaining({ outcome: "failed" })]),
      }));
    } finally { await f.close(); }
  });

  it("allows startup grace, then long silent tool execution, but detects later runtime exit", async () => {
    let alive = false;
    const f = await fixture(async () => alive);
    try {
      await f.tick(10_000);
      expect(f.ingestProviderEvents).not.toHaveBeenCalled();
      alive = true;
      await writeFile(f.path, '{"type":"turn.started"}\n');
      await f.tick(20_000);
      f.ingestProviderEvents.mockClear();
      await f.tick(600_000);
      expect(f.ingestProviderEvents).not.toHaveBeenCalled();
      alive = false;
      await appendFile(f.path, '{"type":');
      await f.tick(610_000);
      expect(f.ingestProviderEvents).toHaveBeenCalledWith(expect.anything(), "thread_test", expect.objectContaining({
        events: expect.arrayContaining([expect.objectContaining({ outcome: "failed" })]),
      }));
    } finally { await f.close(); }
  });

  it("tolerates transient probe errors and persists terminal failure idempotently on repeated errors", async () => {
    const f = await fixture(async () => { throw new Error("unavailable"); });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await f.tick(10_000);
      await f.tick(20_000);
      expect(f.ingestProviderEvents).not.toHaveBeenCalled();
      f.ingestProviderEvents.mockRejectedValueOnce(new Error("temporary store outage"));
      await f.tick(30_000);
      await f.tick(31_000);
      expect(f.ingestProviderEvents).toHaveBeenCalledTimes(2);
      expect(f.ingestProviderEvents.mock.calls[0]).toEqual(f.ingestProviderEvents.mock.calls[1]);
      expect(f.bridge.watcherCount()).toBe(0);
    } finally { await f.close(); warn.mockRestore(); }
  });

  it("does not fail a run on unanswered probes while the runtime awaits a gateway canonical action or keeps producing output", async () => {
    // Live failure: on a saturated 2-vCPU VM, `systemctl --user show` probes timed out 3x in ~25s
    // while Codex was blocked waiting on the gateway's own matrix_open_app execution. The run
    // was declared failed although the runtime was never observed dead.
    const policy = { revision: "r1", actionMode: "canonical_actions" as const, workspaceScope: "apps" as const, tools: ["matrix_open_app" as const], delegation: false as const };
    const identity = { owner: { type: "personal" as const, ownerId: "owner" }, chatId: "chat_1", runId: "run_1" };
    const canonical = { executionPolicy: policy, identity, inventory: [{ toolId: "matrix_open_app" as const, schemaRevision: "v1", description: "Open app",
      effect: "navigation" as const, inputSchema: { type: "object" } }] };
    const request = { ...identity, type: "matrix.codex.action.requested", executionPolicy: policy, actionId: `action_${"a".repeat(32)}`,
      argumentDigest: "b".repeat(64), inventoryDigest: "c".repeat(64), toolCallId: `codex_item_${"d".repeat(32)}`,
      nativeThreadId: "native1", nativeTurnId: "turn1", nativeCallId: "call1", toolId: "matrix_open_app", schemaRevision: "v1", arguments: { app: "notes" } };
    const homePath = await mkdtemp(join(tmpdir(), "codex-supervision-"));
    let now = 0;
    let finishAction!: () => void;
    const actionPending = new Promise<void>((resolve) => { finishAction = resolve; });
    const ingestProviderEvents = vi.fn(async (..._args: unknown[]) => ({}));
    const onCanonicalActionRequest = vi.fn(async () => { await actionPending; });
    const bridge = createCodexEventBridge({ homePath, nowMs: () => now, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }),
      isRuntimeAlive: async () => { throw new Error("systemctl timed out"); },
      onCanonicalActionRequest,
    });
    bridge.attachThreadStore({ ingestProviderEvents });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const path = codexProviderEventPath(homePath, "sess_test");
    const tick = async (time: number) => { now = time; await bridge.drain(); };
    const failed = () => ingestProviderEvents.mock.calls.some((call) => (call as unknown as [unknown, unknown, { events: Array<{ outcome?: string }> }])[2]
      .events.some((event) => event.outcome === "failed"));
    try {
      await bridge.watch({ principal: { userId: "owner", source: "jwt" }, threadId: "thread_test", sessionId: "sess_test", canonical });
      await writeFile(path, '{"type":"turn.started"}\n' + JSON.stringify(request) + "\n");
      await tick(1_000);
      expect(onCanonicalActionRequest).toHaveBeenCalledTimes(1);
      // Four consecutive unanswered probes while our own action is in flight: still Working.
      for (const time of [10_000, 20_000, 30_000, 40_000]) await tick(time);
      expect(failed()).toBe(false);
      finishAction();
      await actionPending;
      // Runtime output after the action also counts as liveness evidence.
      await appendFile(path, '{"type":"item.completed","item":{"id":"msg_1","type":"agent_message","text":"Opened Notes"}}\n');
      for (const time of [50_000, 60_000]) await tick(time);
      expect(failed()).toBe(false);
      // Only a silent runtime with repeated unanswered probes ends the run.
      for (const time of [70_000, 80_000, 90_000]) await tick(time);
      expect(failed()).toBe(true);
      expect(bridge.watcherCount()).toBe(0);
    } finally { await bridge.shutdown(); await rm(homePath, { recursive: true, force: true }); warn.mockRestore(); }
  });

  it("fences a stale liveness probe after the watcher is replaced for a new turn", async () => {
    let resolveProbe!: (alive: boolean) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const f = await fixture(() => { entered(); return new Promise<boolean>((resolve) => { resolveProbe = resolve; }); });
    try {
      const draining = f.tick(61_000);
      await started;
      await f.watch(true);
      resolveProbe(false);
      await draining;
      expect(f.ingestProviderEvents).not.toHaveBeenCalled();
      expect(f.bridge.watcherCount()).toBe(1);
      f.bridge.unwatch("sess_test");
    } finally { await f.close(); }
  });

  it("retains undrained provider bytes when renewing an existing watcher", async () => {
    const f = await fixture(async () => true);
    try {
      await writeFile(f.path, '{"type":"item.completed","item":{"id":"msg_1","type":"agent_message","text":"Still deliver this"}}\n');
      await f.watch(true);
      await f.tick(1_000);
      expect(f.ingestProviderEvents).toHaveBeenCalledWith(expect.anything(), "thread_test", expect.objectContaining({
        events: expect.arrayContaining([expect.objectContaining({ type: "assistant.text.delta", delta: "Still deliver this" })]),
      }));
    } finally { await f.close(); }
  });

  it.each(["dead", "never-ready"])("finishes %s runtime without waiting for provider bytes", async (mode) => {
    const homePath = await mkdtemp(join(tmpdir(), "codex-supervision-"));
    let now = 0;
    const ingestProviderEvents = vi.fn(async () => ({}));
    const bridge = createCodexEventBridge({ homePath, nowMs: () => now, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }),
      isRuntimeAlive: async () => mode !== "dead",
    });
    bridge.attachThreadStore({ ingestProviderEvents });
    try {
      await bridge.watch({ principal: { userId: "owner", source: "jwt" }, threadId: "thread_test", sessionId: "sess_test" });
      now = 61_000;
      await bridge.drain();
      expect(ingestProviderEvents).toHaveBeenCalledWith(expect.anything(), "thread_test", expect.objectContaining({
        events: expect.arrayContaining([expect.objectContaining({ type: "thread.completed", outcome: "failed" })]),
      }));
      await bridge.drain();
      expect(ingestProviderEvents).toHaveBeenCalledTimes(1);
    } finally { await bridge.shutdown(); await rm(homePath, { recursive: true, force: true }); }
  });

  it("drains successful completion before declaring a dead runtime failed", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "codex-supervision-"));
    let now = 0;
    const ingestProviderEvents = vi.fn(async () => ({}));
    const bridge = createCodexEventBridge({ homePath, nowMs: () => now, pollIntervalMs: 60_000,
      runVersionCommand: async () => ({ stdout: `codex-cli ${CODEX_VERIFIED_VERSION}`, stderr: "" }),
      isRuntimeAlive: async () => false,
    });
    bridge.attachThreadStore({ ingestProviderEvents });
    try {
      await bridge.watch({ principal: { userId: "owner", source: "jwt" }, threadId: "thread_test", sessionId: "sess_test" });
      await writeFile(codexProviderEventPath(homePath, "sess_test"), '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n');
      now = 61_000;
      await bridge.drain();
      const events = ingestProviderEvents.mock.calls.flatMap((call) => (call as unknown as [unknown, unknown, {events: Array<{outcome?: string}>}])[2].events);
      expect(events.some((event) => event.outcome === "completed")).toBe(true);
      expect(events.some((event) => event.outcome === "failed")).toBe(false);
    } finally { await bridge.shutdown(); await rm(homePath, { recursive: true, force: true }); }
  });
});
