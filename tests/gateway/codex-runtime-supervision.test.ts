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
