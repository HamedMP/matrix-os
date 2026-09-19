import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
import { TerminalRuntimeSocketClient, type TerminalRuntimeSocketStream } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { createTerminalSizeLease } from "../../packages/gateway/src/terminal-size-lease.js";

it("keeps a revoked viewer attached when release races the socket handshake", async () => {
  const homePath = await mkdtemp("/tmp/matrix-attach-order-");
  let emit: ((data: Uint8Array) => void) | undefined;
  const adapter: ZellijRuntimeAdapter = {
    ensureSession: async () => {}, createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
    subscribeWorkspace: async () => ({ close: async () => {} }),
    openAttachment: async (_session, input) => {
      emit = input.onData;
      return { write: async () => {}, resize: async () => {}, close: async () => {} };
    },
    resizeSession: async () => {},
  };
  const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij: adapter });
  const socketPath = join(homePath, "r.sock");
  const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
  let observer: TerminalRuntimeSocketStream | undefined;
  let writer: TerminalRuntimeSocketStream | undefined;
  try {
    await server.start();
    const workspace = await runtime.ensureWorkspace();
    const tab = await runtime.createTab(workspace.id, { name: "race", cwd: "" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const lease = createTerminalSizeLease(ref, (frame) => observer?.send(frame));
    lease.revoke(); // Ownership was lost while gateway admission was pending.
    const client = new TerminalRuntimeSocketClient({ socketPath });
    const onFrame = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    observer = client.attach({ ref, viewerId: "revoked", mode: "hard", size: { cols: 180, rows: 60 },
      onFrame, onClose, onError });
    lease.attached(); // Send the deferred release before the Unix socket connects.
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ type: "attached" })));
    writer = client.attach({ ref, viewerId: "writer", mode: "hard", size: { cols: 100, rows: 30 },
      onFrame() {}, onClose() {}, onError });
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({
      type: "canonical-size", canonicalSize: { cols: 100, rows: 30 },
    })));
    emit!(Buffer.from("observer still receives output"));
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalledWith(expect.objectContaining({ type: "output" })));
    expect(onClose).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    observer?.close(); writer?.close();
    await server.close(); await runtime.shutdown();
    await rm(homePath, { recursive: true, force: true });
  }
});
