import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalRuntime } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe("terminal workspace startup recovery", () => {
  it("isolates an exited session, preserves history, and restores it when available again", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-recovery-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    const unavailable = await store.ensureWorkspace();
    const healthy = await store.ensureWorkspace({ projectId: "healthy" });
    const tabs = [];
    for (const workspace of [unavailable, healthy]) {
      const tab = await store.createTab(workspace.id, { name: "saved shell", cwd: "" });
      await store.activateTab({ workspaceId: workspace.id, tabId: tab.id }, { tabId: 7, paneId: "terminal_12" });
      tabs.push(tab);
    }
    const ref = { workspaceId: unavailable.id, tabId: tabs[0]!.id };
    const history = await store.checkpointTab(ref, {
      ansi: "saved terminal output", viewport: ["saved terminal output"], scrollback: ["earlier output"],
    });
    const before = await store.getRuntimeWorkspace(unavailable.id);
    const healthyState = (await store.getRuntimeWorkspace(healthy.id))!;
    let exited = true;
    const run = vi.fn(async (args: string[]) => {
      const session = args[1];
      if (session === before!.zellijSessionName && exited) {
        // Zellij returns exit 0 and a colored session inventory when the
        // keeper is still active but the requested session has exited.
        return `\x1b[32;1m${session}\x1b[0m [Created 2 days ago] (EXITED)\n`;
      }
      const state = session === before!.zellijSessionName ? before! : healthyState;
      const internalName = Object.values(state.tabs)[0]!.zellijTabName;
      if (args.includes("list-tabs")) return JSON.stringify([{ tab_id: 7, name: internalName }]);
      if (args.includes("list-panes")) return JSON.stringify([{ id: 12, is_plugin: false, tab_id: 7, pane_title: internalName }]);
      throw new Error("Recovery must not replay commands or delete saved sessions");
    });
    const lifecycle = {
      ensureWorkspaceSession: vi.fn(async (sessionName: string) => ({ sessionName, binaryPath: "/fake/zellij" })),
      resolveWorkspaceTarget: vi.fn(async (sessionName: string) => ({ sessionName, binaryPath: "/fake/zellij" })),
      deleteWorkspaceSession: vi.fn(),
    };
    const adapter = new ZellijCliRuntimeAdapter({
      homePath, run, workspaceLifecycle: lifecycle,
      spawnSubscription: vi.fn(() => ({ close: async () => undefined })),
    });
    const runtime = new TerminalRuntime({ store, zellij: adapter, maxObservers: 2 });
    const socketPath = join(homePath, "terminal.sock");
    const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(runtime.restoreAll()).resolves.toBeUndefined();
      // Exercise the same RPC used by the installed runtime health check.
      await server.start();
      const client = new TerminalRuntimeSocketClient({ socketPath });
      expect((await client.listWorkspaces()).find((w) => w.id === unavailable.id)?.status).toBe("degraded");
      expect((await runtime.listWorkspaces()).find((w) => w.id === unavailable.id)?.status).toBe("degraded");
      expect((await runtime.listWorkspaces()).find((w) => w.id === healthy.id)?.status).toBe("running");
      expect((await store.getRuntimeWorkspace(unavailable.id))?.tabs).toEqual(before!.tabs);
      expect(await store.readSnapshot(ref)).toEqual(history);
      expect(lifecycle.deleteWorkspaceSession).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledWith("[terminal-runtime] workspace restore deferred", expect.objectContaining({ workspaceId: unavailable.id }));

      // Another startup keeps the degraded record and its history intact.
      const degraded = await store.getRuntimeWorkspace(unavailable.id);
      await runtime.restoreAll();
      expect(await store.getRuntimeWorkspace(unavailable.id)).toEqual(degraded);
      await runtime.shutdown();
      exited = false;
      const recovered = new TerminalRuntime({ store, zellij: adapter });
      try {
        await recovered.restoreAll();
        expect((await recovered.listWorkspaces()).every((w) => w.status === "running")).toBe(true);
        expect(await store.readSnapshot(ref)).toEqual(history);
      } finally { await recovered.shutdown(); }
    } finally {
      await server.close();
      await runtime.shutdown();
    }
  });

  it("does not hide persistent workspace-store failures", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-store-failure-"));
    homes.push(homePath);
    const store = new TerminalWorkspaceStore({ homePath });
    await store.ensureWorkspace();
    const failure = Object.assign(new Error("disk unavailable"), { code: "EIO" });
    vi.spyOn(store, "getRuntimeWorkspace").mockRejectedValue(failure);
    const runtime = new TerminalRuntime({ store, zellij: new ZellijCliRuntimeAdapter({ homePath, run: vi.fn() }) });
    try { await expect(runtime.restoreAll()).rejects.toBe(failure); }
    finally { await runtime.shutdown(); }
  });
});
