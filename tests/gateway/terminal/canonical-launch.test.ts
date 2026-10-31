import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createCanonicalTerminalLaunch } from "../../../packages/gateway/src/terminal/canonical-launch.js";
import type { TerminalSourcePort, RetainedTerminalStartup } from "../../../packages/gateway/src/terminal/retained-binding.js";
import { TerminalRuntime } from "../../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../../packages/terminal-runtime/src/workspace-store.js";
const principal = { userId: "clerk_actual", source: "jwt" as const }, generation = "gen_" + "b".repeat(64);
const supervisor = { pid: 10, ppid: 1, uid: 501, gid: 20, start: "10" }, hostIdentity = { ...supervisor, pid: 20, ppid: 10, start: "20" }, root = { ...supervisor, pid: 30, ppid: 20, start: "30" };
const closes: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
async function fixture(limits: { maxTabsPerWorkspace?: number; maxTabsTotal?: number; maxObservers?: number } = {}) {
  const home = await mkdtemp("/tmp/t7join-"); closes.push(() => rm(home, { recursive: true, force: true }));
  const store = new TerminalWorkspaceStore({ homePath: home }); const channel = new AbortController(); let boundCurrent = true;
  const startup: RetainedTerminalStartup = { heldGeneration: "private-held-launch", signal: channel.signal, current: () => boundCurrent && !channel.signal.aborted,
    verifyCurrent: async () => boundCurrent && !channel.signal.aborted, retire: vi.fn(() => channel.abort()),
    identity: { type: "terminal.bound", admissionId: "de000000-0000-4000-8000-000000000703", supervisor, host: hostIdentity, root, invocationId: "c".repeat(32), generation } };
  let beforeJoin: unknown, port: TerminalSourcePort | undefined;
  const zellij = { ensureSession: vi.fn(async () => {}), createTab: vi.fn(async () => { beforeJoin = await port?.invoke({ operation: "list" }, root, new AbortController().signal); return { tabId: 1, paneId: "terminal_1" }; }),
    subscribeWorkspace: vi.fn(async () => ({ close: async () => {} })), openAttachment: vi.fn() };
  const runtime = new TerminalRuntime({ store, zellij, ...limits, nativeHosts: { attachCommand: async ref => ["/fixed/node", "/fixed/terminal-io-attach.mjs", ref.path], inspect: async () => ({ status: "running" }), stop: vi.fn() } }); closes.push(() => runtime.shutdown());
  const workspace = await runtime.ensureWorkspace(), path = home + "/matrix-terminal-" + "a".repeat(32) + "/io.sock";
  const host = { start: vi.fn(async (input: { onPrepared?: (reference: { path: string }) => Promise<void>; onDispatchSettled?: () => void; onBound?: (value: RetainedTerminalStartup) => Promise<TerminalSourcePort | undefined> }) => { await input.onPrepared?.({ path }); port = await input.onBound?.(startup); input.onDispatchSettled?.(); return { reference: { path }, status: "running" as const }; }) };
  const register = vi.fn(async (_producer: import("../../../packages/gateway/src/bots/routine-action-source-registry.js").RoutineSourceProducer) => { void _producer; throw new Error("No synthetic positive source registration"); });
  const coordinator = createCanonicalTerminalLaunch({ interactiveHostEquivalent: true, runtime, host, launcher: { build: vi.fn(async () => ({ command: "/fixed/claude", args: [], cwd: home, env: { HOME: home, PATH: "/bin" }, inheritEnv: false as const })) },
    generation, homePath: home, computerId: "computer-current", ownerIds: [principal.userId, "configured_platform_owner"],
    routines: { runtime: { register }, binPath: "/fixed/matrix.mjs", endpoint: "http://127.0.0.1:4000/api/routine-cli/execute" }, readProcess: async pid => [supervisor, hostIdentity, root].find(value => value.pid === pid)! }); closes.push(coordinator.close);
  const launch = () => coordinator.launch(principal, workspace.id, { name: "Claude", cwd: "", managedLaunch: { harness: "claude" } });
  return { coordinator, register, store, runtime, zellij, host, launch, workspace, channel, startup, home, path, port: () => port, beforeJoin: () => beforeJoin, loseProof: () => { boundCurrent = false; channel.abort(); } };
}
it("call-before-join is denied without registration; source identity comes only from the actual canonical record", async () => {
  const f = await fixture(), tab = await f.launch();
  expect(f.beforeJoin()).toMatchObject({ error: { code: "unavailable" } }); expect(f.register).not.toHaveBeenCalled();
  await f.port()!.invoke({ operation: "list" }, root, new AbortController().signal);
  expect(f.register).toHaveBeenCalledOnce();
  const producer = f.register.mock.calls[0]![0] as import("../../../packages/gateway/src/bots/routine-action-source-registry.js").RoutineSourceProducer;
  expect(producer.source).toMatchObject({ ownerId: principal.userId, computerId: "computer-current", harness: "claude", identity: { kind: "terminal_launch", sessionId: `${f.workspace.id}:${tab.id}`, incarnationId: tab.incarnation } });
  expect(producer.publish).toBeUndefined();
});
it("failed canonical creation closes proof but retains native I/O recovery and does not invent source", async () => {
  const f = await fixture(); f.zellij.createTab.mockRejectedValue(new Error("Named pane failure"));
  await expect(f.launch()).rejects.toThrow(); expect(f.register).not.toHaveBeenCalled();
  const tabs = (await f.store.listWorkspaces())[0]!.tabs;
  expect(tabs).toHaveLength(1); expect(tabs[0]).toMatchObject({ status: "unavailable", nativeHost: { generation } });
  expect(await f.port()!.invoke({ operation: "list" }, root, new AbortController().signal)).toMatchObject({ error: { code: "unavailable" } });
});
it.each(["removed", "stop fence", "incarnation", "public path", "proof loss"])("denies %s against the real record while preserving native I/O", async reason => {
  const f = await fixture(), tab = await f.launch(), ref = { workspaceId: f.workspace.id, tabId: tab.id };
  if (reason === "removed") await f.store.removeTab(ref);
  if (reason === "stop fence") await f.store.fenceNativeHost(ref);
  if (reason === "incarnation" || reason === "public path") {
    await f.store.removeTab(ref);
    await f.runtime.createTab(ref.workspaceId, { tabId: ref.tabId, name: "Replacement", cwd: "", ...(reason === "public path" ? { nativeHost: { ...tab.nativeHost!, path: tab.nativeHost!.path.replace("a".repeat(32), "d".repeat(32)) } } : {}) });
  }
  if (reason === "proof loss") f.loseProof();
  await f.port()!.invoke({ operation: "list" }, root, new AbortController().signal);
  expect(f.register).not.toHaveBeenCalled(); expect(await f.coordinator.available(ref)).toBe(false);
  expect(f.startup.retire).toHaveBeenCalledOnce();
});
it("a repeated tab ID or restored public reference never creates another native root or new source", async () => {
  const f = await fixture(), tab = await f.launch(); await f.coordinator.close();
  expect(f.host.start).toHaveBeenCalledOnce(); expect(f.register).not.toHaveBeenCalled();
  expect(await f.store.getTab({ workspaceId: f.workspace.id, tabId: tab.id })).toMatchObject({ nativeHost: { generation } });
});
it("configured owner metadata cannot create a human source or alias the Clerk namespace", async () => {
  const f = await fixture();
  await f.coordinator.launch({ userId: "configured_platform_owner", source: "configured-container" }, f.workspace.id, { name: "Claude", cwd: "", managedLaunch: { harness: "claude" } });
  expect(f.port()).toBeUndefined(); expect(f.register).not.toHaveBeenCalled();
});

it("canonical expiry retires held proof with the native workload still alive", async () => {
  const f = await fixture(); vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const tab = await f.launch(); await vi.advanceTimersByTimeAsync(30 * 60000 + 1);
    expect(f.startup.retire).toHaveBeenCalledOnce(); expect(f.channel.signal.aborted).toBe(true);
    expect(await f.store.getTab({ workspaceId: f.workspace.id, tabId: tab.id })).toMatchObject({ status: "running" });
  } finally { vi.useRealTimers(); }
});
it("failed pane join retires held private proof without stopping native I/O", async () => {
  const f = await fixture(); f.zellij.createTab.mockRejectedValue(new Error("Named pane failure"));
  await expect(f.launch()).rejects.toThrow(); expect(f.startup.retire).toHaveBeenCalledOnce();
  expect(f.channel.signal.aborted).toBe(true); expect((await f.store.listWorkspaces())[0]!.tabs).toHaveLength(1);
});
it.each(["capacity", "observer", "session"])("canonical %s rejection occurs before native dispatch", async reason => {
  const f = await fixture(reason === "capacity" ? { maxTabsPerWorkspace: 1, maxTabsTotal: 1 } : reason === "observer" ? { maxObservers: 1 } : {});
  if (reason === "capacity") await f.runtime.createTab(f.workspace.id, { name: "Existing", cwd: "" });
  if (reason === "observer") {
    await f.runtime.createTab(f.workspace.id, { name: "Existing", cwd: "" });
    const workspace = await f.runtime.ensureWorkspace({ projectId: "prj_" + "1".repeat(32) }); f.workspace.id = workspace.id;
  }
  if (reason === "session") f.zellij.ensureSession.mockRejectedValue(new Error("Named session failure"));
  let dispatched = false;
  f.host.start.mockImplementation(async input => { await input.onPrepared?.({ path: f.path }); dispatched = true; input.onDispatchSettled?.(); return { reference: { path: f.path }, status: "running" }; });
  await expect(f.launch()).rejects.toThrow(); expect(dispatched).toBe(false); expect(f.register).not.toHaveBeenCalled();
});
it("a concurrent requested ID cannot join a different actual host record", async () => {
  const f = await fixture(), tabId = "tt_" + "8".repeat(32), otherPath = f.path.replace("a".repeat(32), "d".repeat(32));
  f.host.start.mockImplementation(async input => {
    await f.runtime.createTab(f.workspace.id, { tabId, name: "Interleaved", cwd: "", nativeHost: { path: otherPath, generation } });
    await input.onPrepared?.({ path: f.path });
    await input.onBound?.(f.startup); input.onDispatchSettled?.();
    return { reference: { path: f.path }, status: "running" };
  });
  try { await f.coordinator.launch(principal, f.workspace.id, { tabId, name: "Claude", cwd: "", managedLaunch: { harness: "claude" } }); } catch { /* Admission conflict is expected after the fix. */ }
  expect(await f.coordinator.available({ workspaceId: f.workspace.id, tabId })).toBe(false);
  expect(await f.store.getTab({ workspaceId: f.workspace.id, tabId })).toMatchObject({ nativeHost: { path: otherPath } });
});

it("requires the actual host result to match its privately retained reservation", async () => {
  const f = await fixture();
  f.host.start.mockImplementation(async input => {
    await input.onPrepared?.({ path: f.path }); await input.onBound?.(f.startup); input.onDispatchSettled?.();
    return { reference: { path: f.path.replace("a".repeat(32), "d".repeat(32)) }, status: "running" };
  });
  await expect(f.launch()).rejects.toThrow(); expect(f.startup.retire).toHaveBeenCalledOnce();
  expect(f.register).not.toHaveBeenCalled();
  expect((await f.store.listWorkspaces())[0]!.tabs[0]).toMatchObject({ status: "unavailable", nativeHost: { path: f.path } });
});
it("pending dispatch has a real reserved incarnation and cannot be commandeered, restored as a workload, or deleted", async () => {
  const f = await fixture(), tabId = "tt_" + "9".repeat(32);
  let release!: () => void, prepared!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { prepared = resolve; });
  f.host.start.mockImplementation(async input => { await input.onPrepared?.({ path: f.path }); prepared(); await held;
    await input.onBound?.(f.startup); input.onDispatchSettled?.(); return { reference: { path: f.path }, status: "running" }; });
  const work = f.coordinator.launch(principal, f.workspace.id, { tabId, name: "Claude", cwd: "", managedLaunch: { harness: "claude" } });
  await ready;
  try {
    const ref = { workspaceId: f.workspace.id, tabId }, reserved = await f.store.getTab(ref);
    expect(reserved).toMatchObject({ status: "starting", nativeHost: { path: f.path, dispatchPending: true } }); expect(reserved!.incarnation).toMatch(/^ti_/);
    expect(await f.runtime.createTab(f.workspace.id, { tabId, name: "Hijack", cwd: "", command: ["false"] })).toEqual(reserved);
    expect(f.zellij.createTab).not.toHaveBeenCalled();
    await expect(f.runtime.deleteTab(ref)).rejects.toThrow();
    expect(await f.store.getTab(ref)).toMatchObject({ status: "unavailable", nativeHost: { dispatchPending: true, stopRequested: true } });
    await f.runtime.restoreAll(); expect(f.zellij.createTab).not.toHaveBeenCalled();
  } finally { release(); }
  const result = await work;
  expect(result.status).toBe("unavailable"); expect(result.nativeHost?.dispatchPending).toBeUndefined();
  expect(result.nativeHost?.stopRequested).toBe(true); expect(f.register).not.toHaveBeenCalled();
});
