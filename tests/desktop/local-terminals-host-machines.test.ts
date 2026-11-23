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

function start(script: (core: ReturnType<typeof fakeCore>, call: Call) => void) {
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
