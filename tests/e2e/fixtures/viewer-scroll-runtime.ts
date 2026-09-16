import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalRuntime } from "../../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../../packages/terminal-runtime/src/workspace-store.js";

export async function createViewerScrollRuntime(modes: string) {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-scroll-browser-"));
  const writes: Uint8Array[] = [];
  const runtime = new TerminalRuntime({
    store: new TerminalWorkspaceStore({ homePath }),
    zellij: {
      ensureSession: async () => {},
      createTab: async () => ({ tabId: 1, paneId: "terminal_1" }),
      subscribeWorkspace: async () => ({ close: async () => {} }),
      openAttachment: async (_session, input) => {
        for (const byte of new TextEncoder().encode("\x1b[?1049h" + modes)) input.onData(Uint8Array.of(byte));
        return { write: async (data) => { writes.push(data); }, resize: async () => {}, close: async () => {} };
      },
    },
  });
  const cleanup = async () => {
    await runtime.shutdown();
    await rm(homePath, { recursive: true, force: true });
  };
  try {
    const workspace = await runtime.ensureWorkspace();
    const tab = await runtime.createTab(workspace.id, { name: "fixture", cwd: "" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    await runtime.attach(ref, { viewerId: "first", send: () => {} });
    return { runtime, ref, writes, cleanup };
  } catch (error: unknown) {
    await cleanup();
    throw error;
  }
}
