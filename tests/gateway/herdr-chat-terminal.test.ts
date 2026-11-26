import { mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTerminalRef } from "../../packages/gateway/src/herdr/refs.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";
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
