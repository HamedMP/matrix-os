import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalRuntime, type ZellijRuntimeAdapter } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
const nativeHost = { path: "/run/user/501/matrix-terminal-" + "a".repeat(32) + "/io.sock", generation: "gen_" + "b".repeat(64) };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(stopStatus: "stopped" | "unknown" = "stopped") {
  const homePath = await mkdtemp(join(tmpdir(), "terminal-native-lifecycle-"));
  const store = new TerminalWorkspaceStore({ homePath });
  const ids = { tabId: 1, paneId: "terminal_1" }; let found = true;
  const zellij: ZellijRuntimeAdapter = { ensureSession: vi.fn(async () => {}), createTab: vi.fn(async () => ids),
    findTabByInternalName: vi.fn(async () => found ? ids : undefined),
    openAttachment: vi.fn(), subscribeWorkspace: vi.fn(async () => ({ close: async () => {} })),
    closeTab: vi.fn(async () => { found = false; }), deleteSession: vi.fn(async () => { found = false; }),
    getCommandState: vi.fn(async () => "exited" as const), getCommandResult: vi.fn(async () => ({ state: "exited" as const, exitCode: 0 })),
  };
  const host = { inspect: vi.fn(async () => ({ status: "running" })), stop: vi.fn(async () => ({ status: stopStatus })),
    attachCommand: vi.fn(async () => ["/pinned/node", "/pinned/terminal-io-attach.mjs", nativeHost.path]) };
  const runtime = new TerminalRuntime({ store, zellij, nativeHosts: host } as never);
  cleanup.push(async () => { await runtime.shutdown(); await rm(homePath, { recursive: true, force: true }); });
  const workspace = await runtime.ensureWorkspace();
  const tab = await runtime.createTab(workspace.id, { name: "Hermes", cwd: "", nativeHost } as never);
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  return { runtime, store, host, zellij, workspace, tab, ref, losePane: () => { found = false; } };
}
it("persists public native I/O metadata and launches the fixed pinned attach helper", async () => {
  const f = await fixture();
  expect((await f.store.getTab(f.ref))?.nativeHost).toEqual(nativeHost);
  expect(f.zellij.createTab).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ command: ["/pinned/node", "/pinned/terminal-io-attach.mjs", nativeHost.path] }));
});
it.each(["terminateTab", "deleteTab", "deleteWorkspace"] as const)("runtime-owned %s fences before stop and retains unknown native outcome/history", async method => {
  const f = await fixture("unknown");
  f.host.stop.mockImplementation(async () => {
    expect((await f.store.getTab(f.ref))?.nativeHost?.stopRequested).toBe(true);
    return { status: "unknown" };
  });
  const operation = method === "deleteWorkspace" ? f.runtime.deleteWorkspace(f.workspace.id, { confirmTerminate: true }) : f.runtime[method](f.ref);
  await expect(operation).rejects.toMatchObject({ code: "unavailable" });
  expect(f.host.stop).toHaveBeenCalledOnce(); expect(await f.store.getTab(f.ref)).toMatchObject({ status: "unavailable", exitCode: null });
  expect(f.zellij.closeTab).not.toHaveBeenCalled(); expect(f.zellij.deleteSession).not.toHaveBeenCalled();
});
it("successful manager stop is not a native exit code, while explicit deletion can remove the stopped record", async () => {
  const f = await fixture(); await f.runtime.terminateTab(f.ref);
  expect(f.host.stop).toHaveBeenCalledOnce(); expect(await f.store.getTab(f.ref)).toMatchObject({ status: "unavailable", exitCode: null, nativeHost: { managerStopped: true } });
  await f.runtime.deleteTab(f.ref); expect(await f.store.getTab(f.ref)).toBeUndefined();
});
it("restore recreates only an I/O pane for the retained running host and never starts a native child", async () => {
  const f = await fixture(); f.losePane(); await f.runtime.restoreAll();
  expect(f.host.inspect).toHaveBeenCalled(); expect(f.zellij.createTab).toHaveBeenCalledTimes(2); expect(f.host.stop).not.toHaveBeenCalled();
});
it("a helper result cannot establish native success or liveness", async () => {
  const f = await fixture();
  expect(await f.runtime.getCommandResult(f.ref, f.tab.incarnation!)).toEqual({ state: "unknown" });
  expect(await f.runtime.getCommandState(f.ref, f.tab.incarnation)).toBe("unknown");
});
it("runtime shutdown only drains viewers and leaves the native workload alive", async () => {
  const f = await fixture(); await f.runtime.shutdown(); expect(f.host.stop).not.toHaveBeenCalled();
});
it.each(["stopped", "unknown"] as const)("restore keeps a %s host unavailable even when its old helper pane still exists", async status => {
  const f = await fixture(); f.host.inspect.mockResolvedValue({ status });
  await f.runtime.restoreAll();
  expect(await f.store.getTab(f.ref)).toMatchObject({ status: "unavailable", exitCode: null });
  expect(f.zellij.createTab).toHaveBeenCalledOnce(); expect(f.host.stop).not.toHaveBeenCalled();
});
it("ended-tab archival cannot turn an exited helper into proven native completion", async () => {
  const f = await fixture();
  await f.store.removeTab(f.ref);
  const tab = await f.runtime.createTab(f.workspace.id, { name: "Claude", cwd: "", nativeHost, agent: { providerId: "claude" } });
  const ref = { workspaceId: f.workspace.id, tabId: tab.id };
  f.zellij.findTabByInternalNameReadOnly = vi.fn(async () => ({ tabId: 1, paneId: "terminal_1" }));
  await expect(f.runtime.archiveEndedTab(ref, { name: "Archived Claude", expectedName: tab.name, providerId: "claude", expectedIncarnation: tab.incarnation!, baseRevision: tab.revision })).rejects.toMatchObject({ code: "unavailable" });
  expect(await f.store.getTab(ref)).toEqual(tab);
});
