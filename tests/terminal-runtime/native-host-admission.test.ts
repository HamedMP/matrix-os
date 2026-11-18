import { mkdtemp, rm, readFile } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { TerminalRuntime } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { TerminalRuntimeSocketClient } from "../../packages/terminal-runtime/src/socket-client.js";
import { TerminalRuntimeSocketServer } from "../../packages/terminal-runtime/src/socket-server.js";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const home = await mkdtemp("/tmp/t7adm-"); cleanup.push(() => rm(home, { recursive: true, force: true }));
  const store = new TerminalWorkspaceStore({ homePath: home }); let pane = false;
  const zellij = { ensureSession: vi.fn(async () => {}),
    createTab: vi.fn(async (_session: string, _input: { command?: string[] }) => { void _session; void _input; pane = true; return { tabId: 1, paneId: "terminal_1" }; }),
    findTabByInternalName: vi.fn(async () => pane ? { tabId: 1, paneId: "terminal_1" } : undefined),
    subscribeWorkspace: vi.fn(async () => ({ close: async () => {} })), openAttachment: vi.fn(),
    closeTab: vi.fn(async () => { pane = false; }), deleteSession: vi.fn(async () => {}),
  };
  let state: "running" | "stopped" | "unknown" = "stopped";
  const hosts = { inspect: vi.fn(async () => ({ status: state })), stop: vi.fn(async () => { state = "stopped"; return { status: "stopped" as const }; }),
    attachCommand: vi.fn(async (ref: { path: string }) => ["/fixed/node", "/fixed/terminal-io-attach.mjs", ref.path]) };
  const runtime = new TerminalRuntime({ store, zellij, nativeHosts: hosts }); cleanup.push(() => runtime.shutdown());
  const server = new TerminalRuntimeSocketServer({ socketPath: home + "/r.sock", runtime }); await server.start(); cleanup.push(() => server.close());
  const client = new TerminalRuntimeSocketClient({ socketPath: home + "/r.sock" }), workspace = await client.ensureWorkspace();
  const input = { tabId: "tt_" + "7".repeat(32), name: "Claude", cwd: "", nativeHost: {
    path: home + "/matrix-terminal-" + "a".repeat(32) + "/io.sock", generation: "gen_" + "b".repeat(64),
  } };
  return { home, runtime, store, client, workspace, input, ref: { workspaceId: workspace.id, tabId: input.tabId }, zellij, hosts, setRunning: () => { state = "running"; } };
}
it("owner UDS reserves one real incarnation and completes only the exact host reference and incarnation", async () => {
  const f = await fixture();
  const outcomes = await Promise.allSettled([f.client.prepareNativeTab(f.workspace.id, f.input), f.client.prepareNativeTab(f.workspace.id, f.input)]);
  expect(outcomes.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(r => r.status === "rejected")).toHaveLength(1);
  const reserved = await f.store.getTab(f.ref);
  expect(reserved).toMatchObject({ status: "starting", nativeHost: { dispatchPending: true } }); expect(f.zellij.createTab).not.toHaveBeenCalled();
  const owner = outcomes.find(r => r.status === "fulfilled")! as PromiseFulfilledResult<Awaited<ReturnType<typeof f.client.prepareNativeTab>>>;
  const completion = { settlementToken: owner.value.settlementToken, outcome: "settled" as const, nativeHost: f.input.nativeHost, expectedIncarnation: reserved!.incarnation!, attach: true };
  await expect(f.client.completeNativeTab(f.ref, { ...completion, expectedIncarnation: "ti_" + "f".repeat(32) })).rejects.toThrow();
  await expect(f.client.completeNativeTab(f.ref, { ...completion, nativeHost: { ...f.input.nativeHost, path: f.input.nativeHost.path.replace("a".repeat(32), "d".repeat(32)) } })).rejects.toThrow();
  expect((await f.store.getTab(f.ref))?.nativeHost?.dispatchPending).toBe(true);
  expect(await f.client.completeNativeTab(f.ref, completion)).toMatchObject({ status: "running", incarnation: reserved!.incarnation });
  expect((await f.store.getTab(f.ref))?.nativeHost?.dispatchPending).toBeUndefined();
  await expect(f.client.completeNativeTab(f.ref, completion)).rejects.toThrow();
  expect(f.zellij.createTab).toHaveBeenCalledOnce();
});
it("uncertain pending restore reattaches only confirmed live I/O and never promotes pending to running", async () => {
  const f = await fixture(); await f.client.prepareNativeTab(f.workspace.id, f.input);
  await f.runtime.restoreAll(); expect(f.zellij.createTab).not.toHaveBeenCalled();
  f.setRunning(); await f.runtime.restoreAll();
  expect(f.zellij.createTab).toHaveBeenCalledOnce();
  expect(f.zellij.createTab.mock.calls[0]![1]).toMatchObject({ command: ["/fixed/node", "/fixed/terminal-io-attach.mjs", f.input.nativeHost.path] });
  expect(await f.store.getTab(f.ref)).toMatchObject({ status: "unavailable", exitCode: null, nativeHost: { dispatchPending: true } });
});
it("pending explicit close attempts manager stop but retains uncertainty until dispatch settles", async () => {
  const f = await fixture(), reserved = await f.client.prepareNativeTab(f.workspace.id, f.input); f.setRunning();
  await expect(f.client.deleteTab(f.ref)).rejects.toThrow(); expect(f.hosts.stop).toHaveBeenCalledOnce();
  expect(await f.store.getTab(f.ref)).toMatchObject({ nativeHost: { stopRequested: true, dispatchPending: true }, status: "unavailable", exitCode: null });
  await f.client.completeNativeTab(f.ref, { expectedIncarnation: reserved.tab.incarnation!, nativeHost: f.input.nativeHost, attach: true, settlementToken: reserved.settlementToken, outcome: "settled" });
  expect(f.zellij.createTab).not.toHaveBeenCalled();
  await f.client.deleteTab(f.ref); expect(await f.store.getTab(f.ref)).toBeUndefined();
});

it("settlement token is absent from public reads/persistence and missing or guessed tokens cannot consume the lease", async () => {
  const f = await fixture(), reservation = await f.client.prepareNativeTab(f.workspace.id, f.input);
  const publicState = JSON.stringify(await f.client.listWorkspaces()), persisted = await readFile(f.home + "/system/terminal-workspaces.json", "utf8");
  expect(publicState).not.toContain(reservation.settlementToken); expect(persisted).not.toContain(reservation.settlementToken);
  expect(publicState).not.toContain("settlementToken"); expect(persisted).not.toContain("settlementToken");
  const completion = { expectedIncarnation: reservation.tab.incarnation!, nativeHost: f.input.nativeHost, attach: false, outcome: "never-dispatched" as const };
  await expect(f.client.completeNativeTab(f.ref, completion as never)).rejects.toThrow();
  await expect(f.client.completeNativeTab(f.ref, { ...completion, settlementToken: "0".repeat(64) })).rejects.toThrow();
  expect((await f.store.getTab(f.ref))?.nativeHost?.dispatchPending).toBe(true);
  const failed = await f.client.completeNativeTab(f.ref, { ...completion, settlementToken: reservation.settlementToken });
  expect(failed.status).toBe("failed"); expect(failed.nativeHost).toBeUndefined(); expect(failed.exitCode).toBeNull();
  await expect(f.client.completeNativeTab(f.ref, { ...completion, settlementToken: reservation.settlementToken })).rejects.toThrow();
  await f.client.deleteTab(f.ref); expect(await f.store.getTab(f.ref)).toBeUndefined();
});
it("expired or lost runtime leases leave pending recovery and cannot be reconstructed from public IDs", async () => {
  const f = await fixture(), reservation = await f.client.prepareNativeTab(f.workspace.id, f.input);
  const completion = { expectedIncarnation: reservation.tab.incarnation!, nativeHost: f.input.nativeHost, attach: false, outcome: "never-dispatched" as const, settlementToken: reservation.settlementToken };
  vi.useFakeTimers({ toFake: ["Date"] });
  try { vi.setSystemTime(Date.now() + 6 * 60000); await expect(f.client.completeNativeTab(f.ref, completion)).rejects.toThrow(); }
  finally { vi.useRealTimers(); }
  await f.runtime.shutdown();
  const replacement = new TerminalRuntime({ store: f.store, zellij: f.zellij, nativeHosts: f.hosts }); cleanup.push(() => replacement.shutdown());
  await expect(replacement.completeNativeTab(f.ref, completion)).rejects.toThrow();
  expect((await f.store.getTab(f.ref))?.nativeHost?.dispatchPending).toBe(true);
});
