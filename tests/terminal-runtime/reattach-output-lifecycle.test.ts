import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { TerminalRef, TerminalTabServerFrameSchema } from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { TerminalRuntimeSocketClient, type TerminalRuntimeSocketStream } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { terminalTabIncarnation } from "../../packages/terminal-runtime/src/incarnation.js";

type Frame = z.infer<typeof TerminalTabServerFrameSchema>;

// Real store, runtime and Unix transport; only Zellij is deterministic. This
// proves runtime boundaries, not a customer release pair or a real process PID.
async function fixture() {
  const homePath = await mkdtemp("/tmp/matrix-eng294-");
  let emit: ((data: Uint8Array) => void) | undefined;
  const createTab = vi.fn(async () => ({ tabId: 1, paneId: "terminal_1" }));
  const closeTab = vi.fn(async () => {});
  const adapter: ZellijRuntimeAdapter = {
    ensureSession: async () => {}, createTab, closeTab,
    subscribeWorkspace: async () => ({ close: async () => {} }),
    openAttachment: async (_session, input) => {
      emit = input.onData;
      return { write: async () => {}, resize: async () => {}, close: async () => {} };
    },
    resizeSession: async () => {},
  };
  const store = new TerminalWorkspaceStore({ homePath });
  const runtime = new TerminalRuntime({ store, zellij: adapter, sweepIntervalMs: 60_000 });
  const socketPath = join(homePath, "runtime.sock");
  const streams: TerminalRuntimeSocketStream[] = [];
  const directViewers: Awaited<ReturnType<TerminalRuntime["attach"]>>[] = [];
  let server: TerminalRuntimeSocketServer | undefined;
  const cleanup = async () => {
    const results = await Promise.allSettled(streams.map(async (stream) => stream.close()));
    results.push(...await Promise.allSettled([Promise.resolve().then(() => server?.close())]));
    results.push(...await Promise.allSettled(directViewers.map((viewer) => viewer.detach())));
    results.push(...await Promise.allSettled([runtime.shutdown()]));
    results.push(...await Promise.allSettled([rm(homePath, { recursive: true, force: true })]));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), "Fixture cleanup failed");
  };
  try {
    const workspace = await runtime.ensureWorkspace();
    const tab = await runtime.createTab(workspace.id, { name: "reattach", cwd: "" });
    const ref: TerminalRef = { workspaceId: workspace.id, tabId: tab.id };
  return {
    runtime, store, ref, tab, createTab, closeTab,
    emit(data: string) {
      if (!emit) throw new Error("Fixture has no live attachment");
      emit(Buffer.from(data));
    },
    async keepAlive() {
      const viewer = await runtime.attach(ref, { viewerId: "keeper", send() {} });
      directViewers.push(viewer);
      return viewer;
    },
    async start(servedRuntime = runtime) {
      server = new TerminalRuntimeSocketServer({ socketPath, runtime: servedRuntime });
      await server.start();
    },
    attach(viewerId: string, fromSeq = 0) {
      const frames: Frame[] = [];
      const onClose = vi.fn();
      const onError = vi.fn();
      const stream = new TerminalRuntimeSocketClient({ socketPath }).attach({
        ref, viewerId, fromSeq, mode: "soft", size: { cols: 120, rows: 36 },
        onFrame(frame) { frames.push(frame); }, onClose, onError,
      });
      streams.push(stream);
      return { stream, frames, onClose, onError };
    },
    cleanup,
  };
  } catch (error: unknown) {
    try { await cleanup(); }
    catch (cleanupError: unknown) { throw new AggregateError([error, cleanupError], "Fixture setup and cleanup failed"); }
    throw error;
  }
}

const output = (frames: Frame[]) => frames.flatMap((frame) =>
  frame.type === "output" ? [frame.data] : frame.type === "snapshot" ? [frame.ansi] : [],
).join("");

it("makes an expired viewer unavailable instead of ponging while unsubscribed, then reconnects the same tab", async () => {
  const f = await fixture();
  const clock = vi.spyOn(Date, "now");
  let now = Date.now();
  clock.mockImplementation(() => now);
  try {
    await f.start();
    const first = f.attach("first");
    // Output is the registration barrier: attached/replay-end precede runtime.attach.
    await vi.waitFor(() => {
      f.emit("before-expiry\r\n");
      expect(output(first.frames)).toContain("before-expiry");
    });
    now += 120_001;
    // Public attach runs the stale-viewer sweep synchronously before admitting
    // this viewer. No sleeps or private runtime methods are needed.
    await f.keepAlive();
    if (!first.onClose.mock.calls.length) {
      first.stream.send({ type: "ping", terminalRef: f.ref });
    }
    await vi.waitFor(() => expect(
      first.onClose.mock.calls.length > 0 || first.frames.some((frame) =>
        frame.type === "error" || frame.type === "safe-error" || frame.type === "pong"),
    ).toBe(true));
    const unavailable = first.onClose.mock.calls.length > 0 || first.frames.some((frame) =>
      frame.type === "error" || frame.type === "safe-error");
    const pongWhileEvicted = first.frames.some((frame) => frame.type === "pong");

    // Complete recovery assertions even on the broken base, then report the
    // eviction failure. Explicit local close prevents the bad socket leaking.
    first.stream.close();
    const resumed = f.attach("resumed", 1);
    await vi.waitFor(() => {
      f.emit("after-reconnect\r\n");
      expect(output(resumed.frames)).toContain("after-reconnect");
    });
    expect(resumed.onError).not.toHaveBeenCalled();
    expect(resumed.onClose).not.toHaveBeenCalled();
    expect(resumed.frames).toContainEqual(expect.objectContaining({ type: "attached", terminalRef: f.ref }));
    const current = await f.store.getRuntimeWorkspace(f.ref.workspaceId);
    expect(current && terminalTabIncarnation(current.tabs[f.ref.tabId])).toBe(f.tab.incarnation);
    expect(current?.tabs[f.ref.tabId].zellijPaneId).toBe("terminal_1");
    expect(f.createTab).toHaveBeenCalledTimes(1);
    expect(f.closeTab).not.toHaveBeenCalled();
    expect({ unavailable, pongWhileEvicted }).toEqual({ unavailable: true, pongWhileEvicted: false });
  } finally {
    clock.mockRestore();
    await f.cleanup();
  }
});

it("delivers numbered markers in the snapshot-to-live handoff exactly once while an existing viewer stays attached", async () => {
  const f = await fixture();
  const reached = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const registered = Promise.withResolvers<void>();
  // Hold only the new viewer's admission; the existing viewer and observer
  // checkpoint continue. This recreates output arriving after the snapshot read.
  const racing = new Proxy(f.runtime, {
    get(target, property, receiver: unknown) {
      if (property === "attach") return async (...args: Parameters<TerminalRuntime["attach"]>) => {
        reached.resolve();
        await release.promise;
        const viewer = await target.attach(...args);
        registered.resolve();
        return viewer;
      };
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    await f.keepAlive();
    await f.store.checkpointTab(f.ref, { ansi: "before\r\n", viewport: ["before"], scrollback: [] });
    await f.start(racing);
    const resumed = f.attach("handoff");
    await reached.promise;
    // The handshake opens before native admission so startup input can queue;
    // replay framing waits for the admitted baseline.
    await vi.waitFor(() => expect(resumed.frames.some((frame) => frame.type === "attached")).toBe(true));
    expect(resumed.frames.some((frame) => frame.type === "replay-end")).toBe(false);
    f.emit("gap-001\r\ngap-002\r\n");
    await f.store.checkpointTab(f.ref, {
      ansi: "before\r\ngap-001\r\ngap-002\r\n",
      viewport: ["before", "gap-001", "gap-002"], scrollback: [],
    });
    release.resolve();
    await registered.promise;
    f.emit("live-003\r\n");
    resumed.stream.send({ type: "ping", terminalRef: f.ref });
    await vi.waitFor(() => expect(resumed.frames.some((frame) => frame.type === "pong")).toBe(true));
    expect(resumed.onError).not.toHaveBeenCalled();
    expect(resumed.onClose).not.toHaveBeenCalled();
    expect(output(resumed.frames).match(/(?:gap-00[12]|live-003)/g)).toEqual([
      "gap-001", "gap-002", "live-003",
    ]);
    expect(f.createTab).toHaveBeenCalledTimes(1);
    expect(f.closeTab).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await f.cleanup();
  }
});
