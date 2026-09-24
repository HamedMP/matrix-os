import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalRefSchema } from "@matrix-os/contracts";
import { describe, expect, it, vi } from "vitest";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer, type TerminalRuntimeControlApi } from "../../packages/terminal-runtime/src/socket-server.js";

// Exercise the socket boundary with the real strict store, rather than mocks
// that accept mutation fields accidentally passed as part of a terminal ref.
describe("terminal control references", () => {
  async function fixture() {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-control-ref-"));
    const store = new TerminalWorkspaceStore({ homePath });
    const workspace = await store.ensureWorkspace();
    const tab = await store.createTab(workspace.id, { name: "control", cwd: "" });
    const ref = { workspaceId: workspace.id, tabId: tab.id };
    const writeInput = vi.fn(async (inputRef) => { TerminalRefSchema.parse(inputRef); });
    const terminateTab = vi.fn(async (inputRef) => { TerminalRefSchema.parse(inputRef); });
    const resize = vi.fn(async (inputRef) => {
      TerminalRefSchema.parse(inputRef);
      return (await store.listWorkspaces())[0];
    });
    const runtime = {
      updateTabUiState: store.updateTabUiState.bind(store),
      writeInput,
      terminateTab,
      resize,
    } as unknown as TerminalRuntimeControlApi;
    const socketPath = join(homePath, "runtime.sock");
    const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
    await server.start();
    return { homePath, store, tab, ref, writeInput, terminateTab, resize,
      client: new TerminalRuntimeSocketClient({ socketPath }),
      close: async () => { await server.close(); await rm(homePath, { recursive: true, force: true }); },
    };
  }

  it("persists pin and unpin through the socket and preserves revision conflicts", async () => {
    const f = await fixture();
    try {
      const pinned = await f.client.updateTabUiState(f.ref, { pinned: true, baseRevision: f.tab.revision });
      expect(pinned.uiState?.pinned).toBe(true);
      expect((await new TerminalWorkspaceStore({ homePath: f.homePath }).getTab(f.ref))?.uiState?.pinned).toBe(true);
      await expect(f.client.updateTabUiState(f.ref, { pinned: false, baseRevision: f.tab.revision }))
        .rejects.toMatchObject({ code: "conflict" });
      await f.client.updateTabUiState(f.ref, { pinned: false, baseRevision: pinned.revision });
      expect((await new TerminalWorkspaceStore({ homePath: f.homePath }).getTab(f.ref))?.uiState?.pinned).toBe(false);
    } finally { await f.close(); }
  });

  it("separates control input bytes from the strict terminal reference", async () => {
    const f = await fixture();
    try {
      await f.client.writeInput(f.ref, "echo check\r");
      expect(f.writeInput).toHaveBeenCalledWith(f.ref, "echo check\r");
    } finally { await f.close(); }
  });

  it("passes collaboration tab creation proof through the socket for input and termination", async () => {
    const f = await fixture();
    try {
      await f.client.writeInput(f.ref, "echo exact\r", f.tab.incarnation);
      expect(f.writeInput).toHaveBeenCalledWith(f.ref, "echo exact\r", f.tab.incarnation);
      await f.client.terminateTab(f.ref, f.tab.incarnation);
      expect(f.terminateTab).toHaveBeenCalledWith(f.ref, f.tab.incarnation);
    } finally { await f.close(); }
  });

  it.each(["hard", "soft"] as const)("separates %s resize parameters from the strict terminal reference", async (mode) => {
    const f = await fixture();
    try {
      const input = { mode, size: { cols: 100, rows: 30 } };
      await f.client.resize(f.ref, input);
      expect(f.resize).toHaveBeenCalledWith(f.ref, input);
    } finally { await f.close(); }
  });
});
