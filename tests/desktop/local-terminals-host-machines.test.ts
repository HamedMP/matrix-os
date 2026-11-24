import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeCore } from "./fixtures/fake-herdr-core";
import { createLocalTerminalHost, type LocalTerminalHostOptions } from "@desktop/main/local-terminals/host";
import { LOCAL_TERMINAL_VERSION } from "@desktop/shared/local-terminals";

// Spec 2706 layer 7: machines added over ssh keep how they are reached, and
// those settings never outlive the machine they describe.
type Call = { id: number; method: string; params: Record<string, unknown> };
const roots: string[] = [];

function start(script: (core: ReturnType<typeof fakeCore>, call: Call) => void, extra: Partial<LocalTerminalHostOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "mx-machines-"));
  roots.push(root);
  const calls: Call[] = [];
  const opts: LocalTerminalHostOptions = {
    binaryPath: process.execPath, expectedVersion: LOCAL_TERMINAL_VERSION, runtimeDir: join(root, "r"), dataDir: join(root, "d"),
    home: root, shell: "/bin/zsh", uid: userInfo().uid, env: { HOME: root, PATH: "/usr/bin" },
    startCore: vi.fn(async () => undefined),
    openSocket: () => {
      const core = fakeCore();
      core.onCall((call: Call) => { calls.push(call); script(core, call); });
      return core.socket;
    },
    ...extra,
  };
  mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
  return { host: createLocalTerminalHost(opts, { output: vi.fn(), closed: vi.fn() }), dataDir: opts.dataDir, calls };
}

const machine = (name: string, target: string) => ({ name, target, state: "connected", temporary: false });

describe("added machines over ssh", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });
  afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  // Fault detected (Greptile, #3570): settings saved by name reached another host that later took the name.
  it("drops saved settings once the name belongs to a different host", async () => {
    const { host, dataDir } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: [machine("box", "other@elsewhere")] } });
    });
    writeFileSync(join(dataDir, "machine-ssh.json"), JSON.stringify({
      version: 1, machines: { box: { target: "me@box", ssh: { port: 2222 }, coreTarget: "me@box" } },
    }));
    expect(await host.machines()).toEqual([{ name: "box", target: "other@elsewhere", state: "connected", temporary: false }]);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(join(dataDir, "machine-ssh.json"), "utf8")).machines).toEqual({}));
  });

  it("shows how a machine was added while the core's machine is still that one", async () => {
    const { host, dataDir } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: [machine("box", "me@box")] } });
    });
    writeFileSync(join(dataDir, "machine-ssh.json"), JSON.stringify({
      version: 1, machines: { box: { target: "me@box", ssh: { port: 2222 }, coreTarget: "me@box" } },
    }));
    expect(await host.machines()).toEqual([{ name: "box", target: "me@box", state: "connected", temporary: false, ssh: { port: 2222 } }]);
  });

  // Fault detected (Greptile, #3579): a machine installed with a port or jump host lost that route for Open in terminal.
  it("keeps the ssh settings of a machine whose core it installed", async () => {
    const runCoreCli = vi.fn(async () => undefined);
    const { host, dataDir } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: [machine("box", "me@box")] } });
    }, { runCoreCli });
    expect(await host.installMachine({ target: "me@box", name: "box", ssh: { port: 2222, jump: "me@bastion" } })).toEqual({ ok: true });
    expect(runCoreCli).toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(dataDir, "machine-ssh.json"), "utf8")).machines).toEqual({
      box: { target: "me@box", ssh: { port: 2222, jump: "me@bastion" }, coreTarget: "me@box" },
    });
  });

  // Fault detected (Greptile, #3579): a remove and re-add of the name while an install ran paired the
  // replacement machine with the installed host's settings, so Open in terminal reached the old host.
  it("keeps an install and a remove or re-add of the same name from interleaving", async () => {
    let release: () => void = () => undefined;
    const runCoreCli = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    let listed = [machine("box", "me@box")];
    const { host, dataDir } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: listed } });
      if (call.method === "machine.rm") { listed = []; core.reply(call.id, { result: {} }); }
      if (call.method === "machine.add") { listed = [machine("box", "new@box")]; core.reply(call.id, { result: machine("box", "new@box") }); }
    }, { runCoreCli });
    const install = host.installMachine({ target: "me@box", name: "box", ssh: { port: 2222 } });
    await vi.waitFor(() => expect(runCoreCli).toHaveBeenCalled());
    const removed = host.removeMachine("box");
    const added = host.addMachine({ target: "new@box", name: "box" });
    release();
    await Promise.all([install, removed, added]);
    expect(JSON.parse(await readFile(join(dataDir, "machine-ssh.json"), "utf8")).machines).toEqual({
      box: { target: "new@box", coreTarget: "new@box" },
    });
  });

  // Fault detected (Greptile, #3579): the per-name queue took unlimited work in the main process.
  it("refuses machine requests past the queue's limit instead of piling them up", async () => {
    let release: () => void = () => undefined;
    const runCoreCli = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { host } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: [machine("box", "me@box")] } });
      if (call.method === "machine.rm") core.reply(call.id, { result: {} });
    }, { runCoreCli });
    const install = host.installMachine({ target: "me@box", name: "box" });
    await vi.waitFor(() => expect(runCoreCli).toHaveBeenCalled());
    const removes = [host.removeMachine("box"), host.removeMachine("box"), host.removeMachine("box")];
    expect(await host.installMachine({ target: "me@box", name: "box" })).toEqual({ ok: false, reason: "busy" });
    await expect(host.removeMachine("box")).rejects.toThrow("too many machine requests waiting");
    release();
    await Promise.all([install, ...removes]);
    await expect(host.removeMachine("box")).resolves.toBeUndefined();
  });

  // Fault detected (review, #3579): the core update looked the machine up by name when it ran, so after
  // a remove and a re-add of the name for another host it would have updated that other host.
  it("updates only the machine that was picked, and refuses once its name belongs to another host", async () => {
    const runCoreCli = vi.fn(async () => undefined);
    let listed = [machine("box", "me@box")];
    const { host } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: listed } });
      if (call.method === "machine.rm") { listed = []; core.reply(call.id, { result: {} }); }
      if (call.method === "machine.add") { listed = [machine("box", "other@host")]; core.reply(call.id, { result: machine("box", "other@host") }); }
    }, { runCoreCli });
    const picked = (await host.machines()).find((entry) => entry.name === "box")!;
    await host.removeMachine("box");
    await host.addMachine({ target: "other@host", name: "box" });
    expect(await host.updateMachine({ name: "box", target: picked.target })).toEqual({ ok: false, reason: "changed" });
    expect(runCoreCli).not.toHaveBeenCalled();
    expect(await host.updateMachine({ name: "box", target: "other@host" })).toEqual({ ok: true });
    expect(runCoreCli).toHaveBeenCalledTimes(1);
  });

  // Fault detected (Nima, #3579): an update picked for port 2222 went ahead after the same name and
  // address were re-added on port 2223; the check left out the ssh port.
  it("refuses an update once the machine was re-added on another port, or its core changed", async () => {
    const runCoreCli = vi.fn(async () => undefined);
    let listed: Array<Record<string, unknown>> = [machine("box", "me@box")];
    const { host } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: listed } });
      if (call.method === "machine.rm") { listed = []; core.reply(call.id, { result: {} }); }
      if (call.method === "machine.add") { listed = [machine("box", "me@box")]; core.reply(call.id, { result: machine("box", "me@box") }); }
    }, { runCoreCli, probeCoreId: async () => "a".repeat(32) });
    await host.addMachine({ target: "me@box", name: "box", ssh: { port: 2222 } });
    const picked = (await host.machines()).find((entry) => entry.name === "box")!;
    expect(picked.ssh).toEqual({ port: 2222 });
    await host.removeMachine("box");
    await host.addMachine({ target: "me@box", name: "box", ssh: { port: 2223 } });
    expect(await host.updateMachine(picked)).toEqual({ ok: false, reason: "changed" });
    expect(runCoreCli).not.toHaveBeenCalled();

    // With herdr-core's id for the core, the id decides.
    listed = [{ ...machine("box", "me@box"), id: "a".repeat(32) }];
    const byId = (await host.machines()).find((entry) => entry.name === "box")!;
    expect(byId.coreId).toBe("a".repeat(32));
    listed = [{ ...machine("box", "me@box"), id: "b".repeat(32) }];
    expect(await host.updateMachine(byId)).toEqual({ ok: false, reason: "changed" });
    listed = [{ ...machine("box", "me@box"), id: "a".repeat(32) }];
    expect(await host.updateMachine(byId)).toEqual({ ok: true });
    expect(runCoreCli).toHaveBeenCalledTimes(1);
  });

  // Fault detected (Greptile, #3579): an install whose ssh settings could not be saved still reported
  // success, so Open in terminal later lacked the port, identity or jump host.
  it("reports an install whose ssh settings could not be saved and takes the machine back out", async () => {
    const runCoreCli = vi.fn(async () => undefined);
    const { host, dataDir, calls } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: [machine("box", "me@box")] } });
      if (call.method === "machine.rm") core.reply(call.id, { result: {} });
    }, { runCoreCli });
    mkdirSync(join(dataDir, "machine-ssh.json"));
    expect(await host.installMachine({ target: "me@box", name: "box", ssh: { port: 2222 } })).toEqual({ ok: false, reason: "failed" });
    expect(calls.filter((call) => call.method === "machine.rm").map((call) => call.params)).toEqual([{ machine: "box" }]);
    // A plain target needs no saved settings: its install stands.
    expect(await host.installMachine({ target: "me@plain", name: "plain" })).toEqual({ ok: true });
  });

  // Fault detected (Nima, #3579): the id check read only this app's registry, and herdr-core's update then
  // dialed the name again; an ssh alias repointed at another trusted machine would get its core overwritten.
  it("reads the live core's id over the same ssh route and never sends the update to a different core", async () => {
    const runCoreCli = vi.fn(async () => undefined);
    let live = "b".repeat(32);
    const probeCoreId = vi.fn(async () => live);
    const listed = [{ ...machine("box", "me@box"), id: "a".repeat(32) }];
    const { host } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: listed } });
    }, { runCoreCli, probeCoreId });
    const picked = (await host.machines()).find((entry) => entry.name === "box")!;
    expect(await host.updateMachine(picked)).toEqual({ ok: false, reason: "changed" });
    expect(probeCoreId).toHaveBeenCalledWith(expect.arrayContaining(["ssh", "-o", "BatchMode=yes", "--", "me@box"]));
    expect(runCoreCli).not.toHaveBeenCalled();

    // A probe that fails refuses too: the update is never sent blind.
    probeCoreId.mockRejectedValueOnce(new Error("timed out"));
    expect(await host.updateMachine(picked)).toEqual({ ok: false, reason: "failed" });
    expect(runCoreCli).not.toHaveBeenCalled();

    live = "a".repeat(32);
    expect(await host.updateMachine(picked)).toEqual({ ok: true });
    expect(runCoreCli).toHaveBeenCalledTimes(1);
  });

  // Fault detected (Nima, #3579): "Install core there" on user@host:2222 handed the raw address to
  // herdr-core's installer, which took host:2222 as the host name.
  it("installs the core over ssh with the port split out, typed inline or in the advanced field", async () => {
    const runCoreCli = vi.fn(async () => undefined);
    const { host } = start((core, call) => {
      if (call.method === "machine.list") core.reply(call.id, { result: { machines: [machine("box", "me@box")] } });
    }, { runCoreCli });
    await host.installMachine({ target: "me@box:2222", name: "box" });
    await host.installMachine({ target: "me@box", name: "box2", ssh: { port: 2200 } });
    const argv = runCoreCli.mock.calls.map((call) => (call as unknown as [string, string[]])[1]);
    expect(argv[0]).toEqual(["machine", "add", "--install", "--name", "box", "--via", "ssh -o BatchMode=yes -p 2222 -- 'me@box'"]);
    expect(argv[1]).toEqual(["machine", "add", "--install", "--name", "box2", "--via", "ssh -o BatchMode=yes -p 2200 -- 'me@box'"]);
  });

  // Fault detected (Greptile, #3570): a failed save left the machine added without its settings,
  // and an unreadable settings file was replaced, erasing every machine's settings.
  it("takes the machine back out when its settings cannot be saved, and never overwrites an unreadable file", async () => {
    const { host, dataDir, calls } = start((core, call) => {
      if (call.method === "machine.add") core.reply(call.id, { result: machine("box", "me@box") });
      if (call.method === "machine.rm") core.reply(call.id, { result: {} });
    });
    // A settings "file" that cannot be read as one.
    mkdirSync(join(dataDir, "machine-ssh.json"));
    await expect(host.addMachine({ target: "me@box", ssh: { port: 2222 } })).rejects.toThrow();
    expect(calls.filter((call) => call.method === "machine.rm").map((call) => call.params)).toEqual([{ machine: "box" }]);
  });
  // Fault detected (Greptile, #3570): a slow refresh deleted settings saved for a re-added machine meanwhile.
  it("keeps settings saved for a re-added machine while an older refresh was waiting", async () => {
    let listed: (() => void) | null = null;
    const { host, dataDir } = start((core, call) => {
      if (call.method === "machine.list") listed = () => core.reply(call.id, { result: { machines: [machine("box", "other@elsewhere")] } });
      if (call.method === "machine.add") core.reply(call.id, { result: machine("box", "new@box") });
    });
    writeFileSync(join(dataDir, "machine-ssh.json"), JSON.stringify({
      version: 1, machines: { box: { target: "me@box", coreTarget: "me@box" } },
    }));
    const refresh = host.machines();
    await vi.waitFor(() => expect(listed).not.toBeNull());
    await host.addMachine({ target: "new@box", ssh: { port: 2200 } });
    listed!();
    await refresh;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.parse(await readFile(join(dataDir, "machine-ssh.json"), "utf8")).machines.box)
      .toEqual({ target: "new@box", ssh: { port: 2200 }, coreTarget: "new@box" });
  });

  // Fault detected (Greptile, #3570): removal failed after the core had removed the machine, and a retry could never finish.
  it("reports a removal done once the core removed the machine, even if its settings cannot be cleared", async () => {
    const { host, dataDir, calls } = start((core, call) => {
      if (call.method === "machine.rm") core.reply(call.id, { result: {} });
    });
    mkdirSync(join(dataDir, "machine-ssh.json"));
    await expect(host.removeMachine("box")).resolves.toBeUndefined();
    expect(calls.filter((call) => call.method === "machine.rm")).toHaveLength(1);
  });
});
