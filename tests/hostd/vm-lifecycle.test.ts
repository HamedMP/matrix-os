import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChClient, ChVmInfo } from "../../packages/hostd/src/ch-client.js";
import type { Exec } from "../../packages/hostd/src/exec.js";
import {
  createVmLifecycle,
  LifecycleError,
  type CreateVmSpec,
  type LifecycleClock,
  type LifecycleConfig,
  type VmLifecycle,
} from "../../packages/hostd/src/vm-lifecycle.js";
import { createVmStore, type VmStore } from "../../packages/hostd/src/vm-store.js";

const UNIT_DIR = resolve(__dirname, "../../distro/metal-host/systemd");

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, resolve: release };
}

let root: string;
let vmsDir: string;
let snapshotsDir: string;
let events: string[];
let execCalls: string[][];
let execFailures: Map<string, number>;
let lvExists: boolean;
let chState: ChVmInfo["state"];
let snapshotError: Error | null;
let resumeError: Error | null;
let trimGate: Deferred | null;
let healthy: (now: number) => boolean;
let freeBytes: number;
let clock: LifecycleClock & { t: number };
let store: VmStore;
let lifecycle: VmLifecycle;

const spec: CreateVmSpec = {
  machineId: "machine-1",
  generation: 1,
  handle: "alice",
  tier: "free",
  bootMiB: 2048,
  maxMiB: 8192,
  diskGiB: 20,
  userData: "#cloud-config\nhostname: alice\n",
  goldenVersion: "2026.11.20-1",
};

const fakeExec: Exec = async (argv) => {
  const cmd = [...argv];
  execCalls.push(cmd);
  events.push(`exec:${cmd.join(" ")}`);
  if (cmd[0] === "lvs" && cmd.includes("data_percent,metadata_percent")) return { code: 0, stdout: "  10.00  5.00\n", stderr: "" };
  if (cmd[0] === "lvs" && cmd.includes("lv_size")) return { code: 0, stdout: "  21474836480\n", stderr: "" };
  if (cmd[0] === "cloud-localds") await writeFile(cmd[cmd.length - 3]!, "seed-image");
  if (cmd[0] === "lvs") return { code: lvExists ? 0 : 5, stdout: "", stderr: "" };
  if (cmd[0] === "lvremove") lvExists = false;
  if (cmd[0] === "lvcreate") lvExists = true;
  if (cmd[0] === "systemctl" && cmd[1] === "start") chState = cmd[2]!.startsWith("matrix-vm-restore@") ? "Paused" : "Running";
  const fail = execFailures.get(cmd[0]!);
  if (fail !== undefined) return { code: fail, stdout: "", stderr: "boom /secret/path" };
  return { code: 0, stdout: "", stderr: "" };
};

function fakeCh(): ChClient {
  return {
    async info() {
      events.push("ch:info");
      return { state: chState, memoryActualBytes: 2048 * 1024 * 1024 };
    },
    async pause() {
      events.push("ch:pause");
      chState = "Paused";
    },
    async resume() {
      events.push("ch:resume");
      if (resumeError) throw resumeError;
      chState = "Running";
    },
    async snapshot(destinationDir) {
      events.push(`ch:snapshot ${destinationDir}`);
      if (snapshotError) throw snapshotError;
      await writeFile(join(destinationDir, "memory-ranges"), "mem");
      await writeFile(join(destinationDir, "state.json"), "{}");
    },
    async resizeMemory(totalBytes) {
      events.push(`ch:resize ${totalBytes}`);
    },
    async powerButton() {
      events.push("ch:power-button");
      chState = "Shutdown";
    },
    async shutdownVmm() {},
    async close() {},
  };
}

function makeLifecycle(config: Partial<LifecycleConfig> = {}): VmLifecycle {
  return createVmLifecycle({
    store,
    exec: fakeExec,
    ch: () => fakeCh(),
    pool: { freeBytes: async () => freeBytes },
    gatewayHealth: async () => {
      events.push("health");
      return healthy(clock.t);
    },
    trim: async () => {
      events.push("trim");
      if (trimGate) await trimGate.promise;
    },
    clock,
    log: () => {},
    config: { vmsDir, snapshotsDir, serialLogDir: join(root, "log"), runDir: join(root, "run"), ...config },
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hostd-life-"));
  vmsDir = join(root, "vms");
  snapshotsDir = join(root, "snapshots");
  await mkdir(snapshotsDir);
  events = [];
  execCalls = [];
  execFailures = new Map();
  lvExists = false;
  chState = "Shutdown";
  snapshotError = null;
  resumeError = null;
  trimGate = null;
  healthy = () => true;
  freeBytes = 1024 ** 4;
  clock = {
    t: 1_000_000,
    now() {
      return this.t;
    },
    async sleep(ms: number) {
      events.push(`sleep:${ms}`);
      this.t += ms;
      await Promise.resolve();
    },
  };
  store = createVmStore(vmsDir);
  lifecycle = makeLifecycle();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const has = (prefix: string) => execCalls.some((c) => c.join(" ").startsWith(prefix));
const count = (needle: string) => events.filter((e) => e.includes(needle)).length;

async function createRunning() {
  const vm = await lifecycle.create(spec);
  events = [];
  execCalls = [];
  return vm;
}

async function createSuspended() {
  const vm = await createRunning();
  await lifecycle.suspend(vm.id);
  events = [];
  execCalls = [];
  return vm;
}

describe("VM lifecycle", () => {
  it("create writes the record, clones the golden LV, writes the seed, and starts matrix-vm@<id>", async () => {
    const vm = await lifecycle.create(spec);
    expect(vm.id).toMatch(/^vm_[0-9a-f]{24}$/);
    expect(vm).toMatchObject({ state: "running", privateIPv4: "10.78.0.10", mac: "52:54:00:78:00:0a", chVersion: "v54.1" });
    await expect(store.get(vm.id)).resolves.toEqual(vm);
    expect(execCalls).toContainEqual([
      "lvcreate", "--snapshot", "--setactivationskip", "n", "--activate", "y",
      "--name", `mx-${vm.id}`, "vmvg/golden-2026.11.20-1",
    ]);
    const vmDir = join(vmsDir, vm.id);
    await expect(readFile(join(vmDir, "seed.img"), "utf8")).resolves.toBe("seed-image");
    await expect(stat(join(vmDir, "user-data"))).rejects.toMatchObject({ code: "ENOENT" });
    const env = await readFile(join(vmDir, "unit.env"), "utf8");
    expect(env).toContain(`DISK=/dev/vmvg/mx-${vm.id}\n`);
    expect(env).toContain("BOOT_MIB=2048\n");
    expect(env).toContain("HOTPLUG_MIB=6144\n");
    expect(env).toContain("MAC=52:54:00:78:00:0a\n");
    expect(env).toContain("BRIDGE=brmx\n");
    expect(env).toContain(`SERIAL_PATH=${join(root, "log")}/${vm.id}.serial\n`);
    expect(env).not.toContain("machine-1");
    expect(execCalls.at(-1)).toEqual(["systemctl", "start", `matrix-vm@${vm.id}.service`]);
    const order = execCalls.map((c) => c[0]);
    expect(order.indexOf("lvcreate")).toBeLessThan(order.indexOf("cloud-localds"));

    const second = await lifecycle.create({ ...spec, machineId: "machine-2" });
    expect(second).toMatchObject({ privateIPv4: "10.78.0.11", mac: "52:54:00:78:00:0b" });
    await expect(lifecycle.create(spec)).resolves.toEqual(vm);
    await expect(lifecycle.create({ ...spec, generation: 0 })).rejects.toMatchObject({ code: "conflict" });
    await expect(lifecycle.create({ ...spec, machineId: "m3", goldenVersion: "../x" })).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("create marks the record failed when cloning the golden LV fails", async () => {
    execFailures.set("lvcreate", 5);
    await expect(lifecycle.create(spec)).rejects.toBeInstanceOf(LifecycleError);
    const [vm] = await store.list();
    expect(vm?.state).toBe("failed");
    expect(has("systemctl start")).toBe(false);
  });

  it("suspend trims through the guest agent, waits 5 s, snapshots into the pool, then stops the unit", async () => {
    const vm = await createRunning();
    await lifecycle.suspend(vm.id);
    const snap = join(snapshotsDir, vm.id);
    const i = (e: string) => events.findIndex((x) => x.startsWith(e));
    expect(i("trim")).toBeGreaterThanOrEqual(0);
    expect(i("trim")).toBeLessThan(i("sleep:5000"));
    expect(i("sleep:5000")).toBeLessThan(i("ch:pause"));
    expect(i("ch:pause")).toBeLessThan(i(`ch:snapshot ${snap}.new`));
    expect(i(`ch:snapshot ${snap}.new`)).toBeLessThan(i("exec:systemctl stop"));
    expect(i("exec:systemctl stop")).toBeLessThan(i("exec:fallocate"));
    expect(execCalls).toContainEqual(["fallocate", "--dig-holes", join(snap, "memory-ranges")]);
    await expect(readFile(join(snap, "memory-ranges"), "utf8")).resolves.toBe("mem");
    await expect(stat(`${snap}.new`)).rejects.toMatchObject({ code: "ENOENT" });
    const stored = await store.get(vm.id);
    expect(stored).toMatchObject({ state: "suspended", snapshot: { dir: snap, chVersion: "v54.1" } });
  });

  it("snapshot failure keeps the VM running and the record running", async () => {
    const vm = await createRunning();
    snapshotError = new Error("disk full at /var/lib/x");
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "snapshot_failed" });
    expect(count("ch:resume")).toBe(1);
    expect(chState).toBe("Running");
    expect(has("systemctl stop")).toBe(false);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running", snapshot: null });
    await expect(stat(join(snapshotsDir, `${vm.id}.new`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("suspend refuses with pool_full when freeBytes is below 2 x bootMiB and keeps the VM running", async () => {
    const vm = await createRunning();
    freeBytes = 2 * 2048 * 1024 * 1024 - 1;
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "pool_full" });
    expect(count("trim")).toBe(0);
    expect(count("ch:pause")).toBe(0);
    expect(execCalls).toEqual([]);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("resume restores with memory_restore_mode=ondemand and returns running once the gateway is healthy", async () => {
    const vm = await createSuspended();
    const unit = await readFile(join(UNIT_DIR, "matrix-vm-restore@.service"), "utf8");
    expect(unit).toMatch(/--restore source_url=file:\/\/\$\{SNAPSHOT_DIR\},memory_restore_mode=ondemand/);
    let healthyCalls = 0;
    healthy = () => ++healthyCalls >= 3;
    await expect(lifecycle.resume(vm.id, 2000)).resolves.toBe("running");
    expect(execCalls).toContainEqual(["systemctl", "start", `matrix-vm-restore@${vm.id}.service`]);
    expect(has(`systemctl start matrix-vm@`)).toBe(false);
    expect(events.indexOf("ch:resume")).toBeLessThan(events.indexOf("health"));
    // The ondemand restore still maps the snapshot, so it stays on disk.
    await expect(stat(join(snapshotsDir, vm.id, "memory-ranges"))).resolves.toBeTruthy();
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("resume returns starting when the gateway is not healthy within budgetMs", async () => {
    const vm = await createSuspended();
    healthy = () => false;
    const start = clock.t;
    await expect(lifecycle.resume(vm.id, 1500)).resolves.toBe("starting");
    expect(clock.t - start).toBeGreaterThanOrEqual(1500);
    expect(clock.t - start).toBeLessThan(2500);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("resume during suspend waits for the snapshot and then resumes", async () => {
    const vm = await createRunning();
    trimGate = deferred();
    const suspending = lifecycle.suspend(vm.id);
    await Promise.resolve();
    const resuming = lifecycle.resume(vm.id, 2000);
    trimGate.resolve();
    await suspending;
    await expect(resuming).resolves.toBe("running");
    expect(count("ch:snapshot")).toBe(1);
    const restores = execCalls.filter((c) => c[1] === "start" && c[2]!.startsWith("matrix-vm-restore@"));
    expect(restores).toHaveLength(1);
    const snapAt = events.findIndex((e) => e.startsWith("ch:snapshot"));
    const restoreAt = events.findIndex((e) => e.startsWith("exec:systemctl start matrix-vm-restore@"));
    expect(snapAt).toBeLessThan(restoreAt);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("resume with a mismatched expectedGeneration rejects conflict inside the queue and does not resume", async () => {
    const vm = await createRunning();
    trimGate = deferred();
    const suspending = lifecycle.suspend(vm.id);
    await Promise.resolve();
    // Queued behind the suspend: the fence is checked when it runs, not now.
    const resuming = lifecycle.resume(vm.id, 2000, { expectedGeneration: 2 });
    trimGate.resolve();
    await suspending;
    await expect(resuming).rejects.toMatchObject({ code: "conflict" });
    expect(execCalls.some((c) => c[1] === "start")).toBe(false);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "suspended" });
  });

  it("suspend with a mismatched expectedGeneration rejects conflict and does not suspend", async () => {
    const vm = await createRunning();
    let accepted = false;
    await expect(
      lifecycle.suspend(vm.id, { expectedGeneration: 7, onAccepted: () => (accepted = true) }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(accepted).toBe(false);
    expect(count("ch:snapshot")).toBe(0);
    expect(count("trim")).toBe(0);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("a matching expectedGeneration suspends and resumes; onAccepted fires for joined callers", async () => {
    const vm = await createRunning();
    trimGate = deferred();
    const order: string[] = [];
    const first = lifecycle.suspend(vm.id, { expectedGeneration: 1, onAccepted: () => order.push("a") });
    const joined = lifecycle.suspend(vm.id, { expectedGeneration: 1, onAccepted: () => order.push("b") });
    await expect.poll(() => order).toEqual(["a", "b"]);
    trimGate.resolve();
    await Promise.all([first, joined]);
    expect(count("ch:snapshot")).toBe(1);
    await expect(lifecycle.resume(vm.id, 2000, { expectedGeneration: 1 })).resolves.toBe("running");
    // An operation that settles without calling accept still notifies a joiner.
    const plain = lifecycle.suspend(vm.id);
    await plain;
    let late = false;
    await lifecycle.suspend(vm.id, { onAccepted: () => (late = true) });
    expect(late).toBe(true);
  });

  it("concurrent resume calls share one restore", async () => {
    const vm = await createSuspended();
    const results = await Promise.all([
      lifecycle.resume(vm.id, 2000),
      lifecycle.resume(vm.id, 2000),
      lifecycle.resume(vm.id, 5000),
    ]);
    expect(results).toEqual(["running", "running", "running"]);
    expect(execCalls.filter((c) => c[1] === "start")).toHaveLength(1);
    expect(count("ch:resume")).toBe(1);
  });

  it("a second suspend after an ondemand resume writes beside the mapped snapshot and swaps after the VMM exits", async () => {
    const vm = await createSuspended();
    await lifecycle.resume(vm.id, 2000);
    events = [];
    await lifecycle.suspend(vm.id);
    const snap = join(snapshotsDir, vm.id);
    expect(events).toContain(`ch:snapshot ${snap}.new`);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "suspended", snapshot: { dir: snap } });
  });

  it("destroy removes unit, LV, seed, snapshot and record and is idempotent", async () => {
    const vm = await createSuspended();
    await lifecycle.destroy(vm.id);
    expect(execCalls).toContainEqual([
      "systemctl", "stop", `matrix-vm@${vm.id}.service`, `matrix-vm-restore@${vm.id}.service`,
    ]);
    expect(execCalls).toContainEqual(["lvremove", "--yes", `vmvg/mx-${vm.id}`]);
    await expect(stat(join(vmsDir, vm.id, "seed.img"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(snapshotsDir, vm.id))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(store.get(vm.id)).resolves.toBeNull();
    execCalls = [];
    await expect(lifecycle.destroy(vm.id)).resolves.toBeUndefined();
    expect(execCalls.filter((c) => c[0] === "lvremove")).toEqual([]);
  });

  it("stop powers the guest off, stops both units, and drops the snapshot", async () => {
    const vm = await createSuspended();
    await lifecycle.resume(vm.id, 2000);
    await lifecycle.stop(vm.id);
    expect(events).toContain("ch:power-button");
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "stopped", snapshot: null });
    await expect(stat(join(snapshotsDir, vm.id))).rejects.toMatchObject({ code: "ENOENT" });
    await lifecycle.start(vm.id);
    expect(execCalls.at(-1)).toEqual(["systemctl", "start", `matrix-vm@${vm.id}.service`]);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("the VM directory lets the VM user traverse it while the record stays private", async () => {
    const vm = await lifecycle.create(spec);
    const vmDir = join(vmsDir, vm.id);
    expect(execCalls).toContainEqual(["chgrp", "matrix-vm", vmDir]);
    expect((await stat(vmDir)).mode & 0o777).toBe(0o750);
    expect((await stat(join(vmDir, "record.json"))).mode & 0o777).toBe(0o600);
    const order = execCalls.map((c) => c.join(" "));
    expect(order.indexOf(`chgrp matrix-vm ${vmDir}`)).toBeLessThan(order.indexOf(`systemctl start matrix-vm@${vm.id}.service`));
  });

  it("a cold boot after a Cloud Hypervisor upgrade relabels the record so the next resume restores", async () => {
    const vm = await createSuspended();
    lifecycle = makeLifecycle({ chVersion: "v55.0" });
    await lifecycle.resume(vm.id, 2000);
    expect(execCalls).toContainEqual(["systemctl", "start", `matrix-vm@${vm.id}.service`]);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running", chVersion: "v55.0" });
    await lifecycle.suspend(vm.id);
    await expect(store.get(vm.id)).resolves.toMatchObject({ snapshot: { chVersion: "v55.0" } });
    execCalls = [];
    await lifecycle.resume(vm.id, 2000);
    expect(execCalls).toContainEqual(["systemctl", "start", `matrix-vm-restore@${vm.id}.service`]);
    expect(has("systemctl start matrix-vm@")).toBe(false);
  });

  it("a failed resume after a failed snapshot marks the VM failed and the next resume recovers it", async () => {
    const vm = await createRunning();
    snapshotError = new Error("snapshot broke");
    resumeError = new Error("resume broke");
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "snapshot_failed" });
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "failed" });
    snapshotError = null;
    resumeError = null;
    execCalls = [];
    await expect(lifecycle.resume(vm.id, 2000)).resolves.toBe("running");
    expect(execCalls).toContainEqual(["systemctl", "start", `matrix-vm@${vm.id}.service`]);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("unknown ids reject with not_found", async () => {
    await expect(lifecycle.resume("vm_ffffffffffffffffffffffff", 1000)).rejects.toMatchObject({ code: "not_found" });
    await expect(lifecycle.suspend("nope")).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("VM lifecycle (host API operations)", () => {
  it("a repeated create for a failed record of the same generation destroys it and recreates the VM", async () => {
    execFailures.set("lvcreate", 5);
    await expect(lifecycle.create(spec)).rejects.toMatchObject({ code: "failed" });
    const [failed] = await store.list();
    execFailures.clear();
    execCalls = [];
    const vm = await lifecycle.create(spec);
    expect(vm.id).not.toBe(failed!.id);
    expect(vm.state).toBe("running");
    expect(execCalls).toContainEqual([
      "systemctl", "stop", `matrix-vm@${failed!.id}.service`, `matrix-vm-restore@${failed!.id}.service`,
    ]);
    await expect(store.get(failed!.id)).resolves.toBeNull();
    expect((await store.list()).map((r) => r.id)).toEqual([vm.id]);
  });

  it("a create racing an in-progress create returns the record still creating", async () => {
    const first = lifecycle.create(spec);
    const second = await lifecycle.create(spec);
    expect(second.state).toBe("creating");
    const done = await first;
    expect(done).toMatchObject({ id: second.id, state: "running" });
  });

  it("resize sends the target size to Cloud Hypervisor for a running VM", async () => {
    const vm = await createRunning();
    await lifecycle.resize(vm.id, 3072);
    expect(events).toContain(`ch:resize ${3072 * 1024 * 1024}`);
  });

  it("resize waits behind a suspend in the VM's queue and then refuses without touching Cloud Hypervisor", async () => {
    const vm = await createRunning();
    trimGate = deferred();
    const suspending = lifecycle.suspend(vm.id);
    await Promise.resolve();
    const resizing = lifecycle.resize(vm.id, 3072);
    trimGate.resolve();
    await suspending;
    await expect(resizing).rejects.toMatchObject({ code: "conflict" });
    expect(events.some((e) => e.startsWith("ch:resize"))).toBe(false);
  });

  it("resize rejects a target outside boot..max as invalid", async () => {
    const vm = await createRunning();
    await expect(lifecycle.resize(vm.id, 1024)).rejects.toMatchObject({ code: "invalid" });
    await expect(lifecycle.resize(vm.id, 9216)).rejects.toMatchObject({ code: "invalid" });
  });

  it("setPolicy updates the tier and memory ceiling and the hotplug size of the next boot", async () => {
    const vm = await createRunning();
    const next = await lifecycle.setPolicy(vm.id, { tier: "paid", maxMiB: 16384 });
    expect(next).toMatchObject({ tier: "paid", maxMiB: 16384 });
    await expect(store.get(vm.id)).resolves.toMatchObject({ tier: "paid", maxMiB: 16384 });
    const env = await readFile(join(vmsDir, vm.id, "unit.env"), "utf8");
    expect(env).toContain("HOTPLUG_MIB=14336\n");
    expect(env).toContain("BOOT_MIB=2048\n");
    await expect(lifecycle.setPolicy(vm.id, { tier: "free", maxMiB: 2048 })).rejects.toMatchObject({ code: "invalid" });
  });

  it("idle resolves once every queued operation has settled", async () => {
    const vm = await createRunning();
    trimGate = deferred();
    const suspending = lifecycle.suspend(vm.id);
    let idle = false;
    const waiting = lifecycle.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);
    trimGate.resolve();
    await suspending;
    await waiting;
    expect(idle).toBe(true);
  });
});
