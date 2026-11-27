import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTerminalRef } from "../../packages/gateway/src/herdr/refs.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";
import { discoverChatTerminals } from "../../packages/gateway/src/chat/herdr-discovery.js";
import { readHerdrChatRemoteWorktrees } from "../../packages/gateway/src/herdr/chat-remote.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "herdr-chat-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const core = createFakeHerdrCore();
  core.add("t1", { identity: { pid: 5, created_ms: 51, cwd: root }, status: { state: "working" }, screen: "ready" });
  const target = core.terminals.get("t1")!;
  const adapter = createHerdrAdapter({ open: async () => core.connect(), ttlMs: 0, captureQuietMs: 5, captureMaxMs: 100 });
  cleanup.push(() => adapter.close());
  const controller = new AbortController();
  const inputActivity = createTerminalInputActivity();
  const ref = herdrTerminalRef("t1");
  const revision = (await adapter.listForChatControl()).sessions[0]!.revision!;
  const bind = (cwd = root, rev = revision) =>
    adapter.bindChatTerminal(ref, cwd, { revision: rev, signal: controller.signal, inputActivity });
  return { core, target, adapter, controller, inputActivity, ref, root, revision, bind };
}

describe("private Chat's selected Herdr terminal", () => {
  it("uses one selected live process and preserves canonical text send and read", async () => {
    const { core, target, revision, bind } = await setup();
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    const handle = await bind();
    expect(await handle!.read(0)).toMatchObject({ screen: "ready" });
    expect(await handle!.send("run tests")).toMatchObject({ sent: true });
    expect(target.input).toEqual(["run tests\r"]);
    target.status = { state: "blocked" };
    await expect(handle!.send("yes")).rejects.toMatchObject({ code: "blocked" });
    expect(target.input).toHaveLength(1);
    expect(new Set(core.calls.map(c => c.method))).toEqual(new Set(["terminal.list", "terminal.attach"]));
  });
  it("rejects another worktree, replacement process or missing identity", async () => {
    const { bind, target, adapter, root } = await setup();
    expect(await bind(tmpdir())).toBeNull();
    const handle = await bind();
    target.identity = { pid: 7, created_ms: 52, cwd: root };
    expect(await bind()).toBeNull();
    await expect(handle!.read(0)).rejects.toThrow();
    await expect(handle!.send("stale")).rejects.toThrow();
    delete target.identity;
    expect((await adapter.listForChatControl()).sessions[0]?.revision).toBeUndefined();
    expect(target.input).toEqual([]);
  });
  it("refuses a selection when its launch directory was replaced before the first operation", async () => {
    const { bind, root, target } = await setup();
    const previous = root + "-original";
    await rename(root, previous);
    cleanup.push(() => rm(previous, { recursive: true, force: true }));
    await mkdir(root);
    expect(await bind()).toBeNull();
    expect(target.input).toEqual([]);
  });
  it("honors human typing, abort and explicit scope close", async () => {
    const { controller, inputActivity, ref, target, bind } = await setup();
    const handle = await bind();
    inputActivity.record(ref);
    await expect(handle!.send("collide")).rejects.toMatchObject({ code: "cancelled" });
    handle!.close();
    await expect(handle!.interrupt()).rejects.toThrow();
    const next = await bind();
    controller.abort();
    await expect(next!.read(0)).rejects.toThrow();
    expect(target.input).toEqual([]);
  });
  it("will not resume a selected terminal through a reconnected core", async () => {
    const { bind, core } = await setup();
    const handle = await bind();
    core.crash();
    await expect(handle!.send("stale")).rejects.toThrow();
    expect(core.terminals.get("t1")!.input).toEqual([]);
  });
});

async function remoteSetup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "terminal-control-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const core = createFakeHerdrCore();
  const route = { id: "a".repeat(32), state: "connected" };
  core.machines.set("devbox", route);
  core.machines.set("unconfigured", { id: "d".repeat(32), state: "connected" });
  const remoteRoot = "/checkout/isolated";
  const identity = { pid: 12, created_ms: 113, cwd: remoteRoot };
  core.add("devbox/t2", { identity, screen: "HEL1 output" });
  core.add("devbox/t3", { identity: { ...identity, pid: 13, cwd: "/home/operator" } });
  core.add("unconfigured/t4", { identity, title: "An unrelated open terminal" });
  core.add("t2", { screen: "Main output" });
  const worktreeId = "wt_abcdef012345";
  const adapter = createHerdrAdapter({
    open: async () => core.connect(), ttlMs: 0, captureQuietMs: 5, captureMaxMs: 100,
    remoteWorktrees: [{ machine: "devbox", machineId: route.id, worktreeId, localRoot: root, remoteRoot }],
  });
  cleanup.push(() => adapter.close());
  const ref = herdrTerminalRef("devbox/t2");
  const picker = () => adapter.listForChatControl();
  const selected = (await picker()).sessions.find(session => session.tabId === ref.tabId);
  const bind = (id = worktreeId, cwd = root, revision = selected?.revision ?? "") =>
    adapter.bindChatTerminal(ref, cwd, { revision, worktreeId: id,
      signal: new AbortController().signal, inputActivity: createTerminalInputActivity() });
  return { core, route, selected, root, ref, adapter, picker, bind };
}

describe("direct remote terminal selection from Chat", () => {
  it("lists the exact configured remote process only in the Chat picker and sends to it without a linked desktop", async () => {
    const { adapter, core, ref, selected, picker, bind } = await remoteSetup();
    expect(selected).toMatchObject({ id: "t2", machine: "devbox", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await picker()).sessions.filter(session => session.machine).map(session => session.id)).toEqual(["t2"]);
    expect((await adapter.list()).sessions.map(session => session.tabId)).toEqual([herdrTerminalRef("t2").tabId]);
    expect(adapter.resolve(ref)).toBeUndefined();
    expect(await discoverChatTerminals(adapter, { action: "discover", machine: "machine:devbox" }))
      .toMatchObject({ total: 1, terminals: [{ address: "machine:devbox/t2" }] });
    expect(await discoverChatTerminals(adapter, { action: "discover", machineQuery: "unconfigured" })).toMatchObject({
      machines: [{ id: "machine:unconfigured", online: true, inventoryOnly: true, terminalCount: null }],
    });
    expect(await discoverChatTerminals(adapter, { action: "discover", query: "An unrelated open terminal" }))
      .toMatchObject({ total: 0, terminals: [] });
    const handle = await bind();
    expect(await handle!.read(0)).toMatchObject({ screen: "HEL1 output" });
    expect(await handle!.send("hostname")).toMatchObject({ sent: true });
    expect(core.terminals.get("devbox/t2")?.input).toEqual(["hostname\r"]);
    expect(core.terminals.get("t2")?.input).toEqual([]);
  });

  it("rejects a wrong worktree, an unconnected or replaced machine, and stale process identity", async () => {
    const { core, route, bind, picker } = await remoteSetup();
    expect(await bind("wt_other123456")).toBeNull();
    expect(await bind(undefined, tmpdir())).toBeNull();
    const handle = await bind();
    route.state = "unreachable";
    expect((await picker()).sessions.some(session => session.machine)).toBe(false);
    await expect(handle!.send("after disconnect")).rejects.toMatchObject({ code: "not_found" });
    route.state = "connected";
    route.id = "b".repeat(32);
    expect(await bind()).toBeNull();
    route.id = "a".repeat(32);
    core.terminals.get("devbox/t2")!.identity!.pid++;
    expect(await bind()).toBeNull();
    expect(core.terminals.get("devbox/t2")?.input).toEqual([]);
  });

  it("drops a replacement attachment before its paint or input crosses the scoped stream", async () => {
    const { core, bind } = await remoteSetup();
    const handle = await bind();
    const target = core.terminals.get("devbox/t2")!;
    target.attachIdentity = { ...target.identity!, pid: 91 };
    await expect(handle!.read(0)).rejects.toMatchObject({ code: "not_found" });
    await expect(handle!.send("must not write")).rejects.toMatchObject({ code: "not_found" });
    expect(core.viewers).toHaveLength(0);
    expect(target.input).toEqual([]);
  });

  it("refuses a stale picker revision after Main's worktree directory is replaced", async () => {
    const { bind, root } = await remoteSetup();
    const previous = root + "-old";
    await rename(root, previous);
    cleanup.push(() => rm(previous, { recursive: true, force: true }));
    await mkdir(root);
    expect(await bind()).toBeNull();
  });
});

it("rejects ambiguous remote bindings and non-canonical paths before granting terminal access", () => {
  const mapping = { machine: "devbox", machineId: "a".repeat(32), worktreeId: "wt_abcdef012345",
    localRoot: "/local/checkout", remoteRoot: "/remote/checkout" };
  expect(readHerdrChatRemoteWorktrees(JSON.stringify([mapping]))).toEqual([mapping]);
  expect(readHerdrChatRemoteWorktrees(JSON.stringify([mapping, { ...mapping, worktreeId: "wt_987654fedcba" }]))).toEqual([]);
  expect(readHerdrChatRemoteWorktrees(JSON.stringify([{ ...mapping, remoteRoot: "/remote/../checkout" }]))).toEqual([]);
});
