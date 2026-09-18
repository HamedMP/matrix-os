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
        handle: { resize: async () => { throw new Error("pty_closed"); } }, viewers: new Map(),
      };
      await expect(applyWorkspaceResize({ workspace, resizeSession: async () => {}, closeEmpty,
        attachments: [failedResize, { ref: { workspaceId: workspace.id, tabId: `tt_${"a".repeat(32)}` },
          handle: { resize }, viewers }],
      })).rejects.toThrow("Terminal attachment resize failed");
      expect(live.onCanonicalSize).toHaveBeenCalledOnce();
    } finally {
      errorLog.mockRestore();
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
