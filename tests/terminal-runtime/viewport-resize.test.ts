import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";

describe("workspace viewport resize propagation", () => {
  it("notifies all attached tabs after a hard resize and ignores mobile soft proposals", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-viewport-resize-"));
    let nextTab = 0;
    const resizePty = vi.fn(async () => {});
    const adapter: ZellijRuntimeAdapter = {
      ensureSession: async () => {},
      createTab: async () => ({ tabId: ++nextTab, paneId: `terminal_${nextTab}` }),
      subscribeWorkspace: async () => ({ close: async () => {} }),
      openAttachment: async () => ({ write: async () => {}, resize: resizePty, close: async () => {} }),
      resizeSession: async () => {},
    };
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: adapter });
    const server = new TerminalRuntimeSocketServer({ socketPath: join(homePath, "r.sock"), runtime });
    let stream: { close(): void } | undefined;
    try {
      await server.start();
      const workspace = await runtime.ensureWorkspace();
      const first = await runtime.createTab(workspace.id, { name: "first", cwd: "" });
      const second = await runtime.createTab(workspace.id, { name: "second", cwd: "" });
      const ref = { workspaceId: workspace.id, tabId: first.id };
      const notified = [vi.fn(), vi.fn(), vi.fn()];
      await runtime.attach(ref, { viewerId: "writer", send() {}, onCanonicalSize: notified[0] });
      await runtime.attach(ref, { viewerId: "observer", send() {}, onCanonicalSize: notified[1] });
      await runtime.attach({ ...ref, tabId: second.id }, { viewerId: "second-tab", send() {}, onCanonicalSize: notified[2] });
      const frames: Array<{ type: string; canonicalSize?: { cols: number; rows: number } }> = [];
      const errors: Error[] = [];
      const client = new TerminalRuntimeSocketClient({ socketPath: join(homePath, "r.sock") });
      stream = client.attach({ ref: { ...ref, tabId: second.id }, viewerId: "socket-observer",
        mode: "soft", size: workspace.canonicalSize, fromSeq: Number.MAX_SAFE_INTEGER,
        onFrame: (frame) => { frames.push(frame); }, onClose() {}, onError(error) { errors.push(error); },
      });
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "attached")).toBe(true));
      const size = { cols: 180, rows: 60 };
      await runtime.resize(ref, { mode: "soft", size });
      expect(notified.every((callback) => callback.mock.calls.length === 0)).toBe(true);
      const resized = await runtime.resize(ref, { mode: "hard", size });
      expect(resized.canonicalSize).toEqual(size);
      for (const callback of notified) expect(callback).toHaveBeenCalledWith(size, resized.revision);
      expect(resizePty).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({
        type: "canonical-size", canonicalSize: size, revision: resized.revision,
      })));
      expect(errors).toEqual([]);
    } finally {
      stream?.close();
      await server.close();
      await runtime.shutdown();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});

it("arbitrates hard sizes across workspace tabs and releases disconnected proposals", async () => {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-size-arbitration-"));
  let nextTab = 0;
  const adapter: ZellijRuntimeAdapter = {
    ensureSession: async () => {}, createTab: async () => ({ tabId: ++nextTab, paneId: `terminal_${nextTab}` }),
    subscribeWorkspace: async () => ({ close: async () => {} }),
    openAttachment: async () => ({ write: async () => {}, resize: async () => {}, close: async () => {} }),
    resizeSession: async () => {},
  };
  const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: adapter });
  try {
    const workspace = await runtime.ensureWorkspace();
    const a = await runtime.createTab(workspace.id, { name: "large", cwd: "" });
    const b = await runtime.createTab(workspace.id, { name: "small", cwd: "" });
    const refA = { workspaceId: workspace.id, tabId: a.id };
    const refB = { workspaceId: workspace.id, tabId: b.id };
    const large = await runtime.attach(refA, { viewerId: "large", send() {} });
    await runtime.attach(refB, { viewerId: "small", send() {} });
    await runtime.resize(refA, { mode: "hard", size: { cols: 180, rows: 60 } }, "large");
    expect((await runtime.resize(refB, { mode: "hard", size: { cols: 100, rows: 30 } }, "small")).canonicalSize)
      .toEqual({ cols: 180, rows: 60 });
    expect((await runtime.resize(refA, { mode: "hard", size: { cols: 90, rows: 25 } }, "large")).canonicalSize)
      .toEqual({ cols: 100, rows: 30 });
    await large.detach();
    expect((await runtime.resize(refB, { mode: "hard", size: { cols: 80, rows: 24 } }, "small")).canonicalSize)
      .toEqual({ cols: 80, rows: 24 });
    await expect(runtime.resize(refA, { mode: "hard", size: { cols: 200, rows: 80 } }, "large"))
      .rejects.toThrow();
  } finally {
    await runtime.shutdown();
    await rm(homePath, { recursive: true, force: true });
  }
});

describe("failed attachment recovery", () => {
  it("disconnects stale sockets and reattaches at the persisted geometry", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-resize-recovery-"));
    const opened: Array<{ cols: number; rows: number }> = [];
    const close = vi.fn(async () => {});
    const adapter: ZellijRuntimeAdapter = {
      ensureSession: async () => {},
      createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      subscribeWorkspace: async () => ({ close: async () => {} }),
      openAttachment: async (_session, input) => {
        opened.push(input.size);
        return { write: async () => {}, resize: async () => { throw new Error("pty_closed"); }, close };
      },
      resizeSession: async () => {},
    };
    const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: adapter });
    const socketPath = join(homePath, "r.sock");
    const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
    const streams: Array<{ close(): void }> = [];
    try {
      await server.start();
      const workspace = await runtime.ensureWorkspace();
      const tab = await runtime.createTab(workspace.id, { name: "recovery", cwd: "" });
      const ref = { workspaceId: workspace.id, tabId: tab.id };
      const client = new TerminalRuntimeSocketClient({ socketPath });
      const frames: Array<{ type: string; canonicalSize?: { cols: number; rows: number } }> = [];
      const onClose = vi.fn();
      const connect = (viewerId: string) => client.attach({ ref, viewerId, mode: "soft", size: workspace.canonicalSize,
        fromSeq: Number.MAX_SAFE_INTEGER, onFrame: (frame) => { frames.push(frame); }, onClose, onError: vi.fn(),
      });
      streams.push(connect("before"));
      await vi.waitFor(() => expect(frames.some((frame) => frame.type === "attached")).toBe(true));
      const size = { cols: 190, rows: 65 };
      await expect(runtime.resize(ref, { mode: "hard", size })).rejects.toThrow("Terminal attachment resize failed");
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
      expect(close).toHaveBeenCalledOnce();
      frames.length = 0;
      streams.push(connect("after"));
      await vi.waitFor(() => expect(frames).toContainEqual(expect.objectContaining({ type: "attached", canonicalSize: size })));
      expect(opened).toEqual([workspace.canonicalSize, size]);
    } finally {
      for (const stream of streams) stream.close();
      await server.close();
      await runtime.shutdown();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});

describe("resize subscriber isolation", () => {
  it("evicts a failed listener while delivering geometry to the remaining viewers", async () => {
    const { applyWorkspaceResize } = await import("../../packages/terminal-runtime/src/workspace-resize.js");
    const homePath = await mkdtemp(join(tmpdir(), "matrix-resize-listener-"));
    const store = new TerminalWorkspaceStore({ homePath });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const workspace = await store.ensureWorkspace();
      const dead = { id: "dead", disposeOutput: vi.fn(), onCanonicalSize: vi.fn(() => { throw new Error("closed"); }) };
      const live = { id: "live", disposeOutput: vi.fn(), onCanonicalSize: vi.fn() };
      const viewers = new Map([[dead.id, dead], [live.id, live]]);
      const resize = vi.fn(async () => {});
      const closeEmpty = vi.fn(async () => {});
      await applyWorkspaceResize({ workspace, resizeSession: async () => {}, closeEmpty,
        attachments: [{ ref: { workspaceId: workspace.id, tabId: `tt_${"a".repeat(32)}` }, handle: { resize }, viewers }],
      });
      expect(live.onCanonicalSize).toHaveBeenCalledWith(workspace.canonicalSize, workspace.revision);
      expect(dead.disposeOutput).toHaveBeenCalledOnce();
      expect(viewers.has("dead")).toBe(false);
      expect(closeEmpty).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledOnce();
      live.onCanonicalSize.mockClear();
      const failedResize = { ref: { workspaceId: workspace.id, tabId: `tt_${"b".repeat(32)}` },
        handle: { resize: async () => { throw new Error("pty_closed"); } },
        viewers: new Map([["stale", { id: "stale", disposeOutput: vi.fn(), onDisconnect: vi.fn() }]]),
      };
      await expect(applyWorkspaceResize({ workspace, resizeSession: async () => {}, closeEmpty,
        attachments: [failedResize, { ref: { workspaceId: workspace.id, tabId: `tt_${"a".repeat(32)}` },
          handle: { resize }, viewers }],
      })).rejects.toThrow("Terminal attachment resize failed");
      expect(live.onCanonicalSize).toHaveBeenCalledOnce();
      expect(failedResize.viewers.size).toBe(0);
      expect(closeEmpty).toHaveBeenCalledWith(failedResize.ref);
    } finally {
      errorLog.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
