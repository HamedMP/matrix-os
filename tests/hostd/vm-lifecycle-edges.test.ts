import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChError, type ChClient, type ChVmState } from "../../packages/hostd/src/ch-client.js";
import type { Exec } from "../../packages/hostd/src/exec.js";
import {
  createVmLifecycle,
  type CreateVmSpec,
  type LifecycleConfig,
  type VmLifecycle,
  type VmLifecycleDeps,
} from "../../packages/hostd/src/vm-lifecycle.js";
import { reconcileVms } from "../../packages/hostd/src/reconcile.js";
import { createVmStore, type VmRecord, type VmStore } from "../../packages/hostd/src/vm-store.js";

// Failure and edge paths of the VM lifecycle: queue limits, restore retries,
// cold-boot fallbacks, snapshot swap failures, and stop/destroy corner cases.

let root: string;
let snapshotsDir: string;
let store: VmStore;
let logs: Array<{ event: string; fields: Record<string, unknown> }>;
let execCalls: string[][];
let execFail: (argv: readonly string[]) => number | Error | string | undefined;
let infoStates: Array<ChVmState | Error>;
let chState: ChVmState;
let chOverrides: Partial<ChClient>;
let clockT: number;

const spec: CreateVmSpec = {
  machineId: "machine-1",
  generation: 1,
  handle: "alice",
  tier: "free",
  bootMiB: 2048,
  maxMiB: 8192,
  diskGiB: 20,
  userData: "#cloud-config\n",
  goldenVersion: "2026.11.20-1",
};

const exec: Exec = async (argv) => {
  execCalls.push([...argv]);
  const outcome = execFail(argv);
  if (outcome instanceof Error || typeof outcome === "string") throw outcome;
  if (typeof outcome === "number") return { code: outcome, stdout: "", stderr: "" };
  if (argv[0] === "systemctl" && argv[1] === "start") chState = "Running";
  return { code: argv[0] === "lvs" ? 5 : 0, stdout: "", stderr: "" };
};

function ch(): ChClient {
  const ok = async () => undefined;
  return {
    async info() {
      const next = infoStates.shift();
      if (next instanceof Error) throw next;
      return { state: next ?? chState, memoryActualBytes: 2048 * 1024 * 1024 };
    },
    pause: ok,
    resume: ok,
    async snapshot(dir) {
      await writeFile(join(dir, "memory-ranges"), "mem");
    },
    resizeMemory: ok,
    async powerButton() {
      chState = "Shutdown";
    },
    shutdownVmm: ok,
    close: ok,
    ...chOverrides,
  };
}

function make(deps: Partial<VmLifecycleDeps> = {}, config: Partial<LifecycleConfig> = {}): VmLifecycle {
  return createVmLifecycle({
    store,
    exec,
    ch: () => ch(),
    pool: { freeBytes: async () => 1024 ** 4 },
    gatewayHealth: async () => true,
    trim: async () => undefined,
    clock: {
      now: () => clockT,
      async sleep(ms) {
        clockT += ms;
      },
    },
    log: (event, fields) => logs.push({ event, fields }),
    config: {
      vmsDir: join(root, "vms"),
      snapshotsDir,
      serialLogDir: join(root, "log"),
      runDir: join(root, "run"),
      trimSettleMs: 0,
      ...config,
    },
    ...deps,
  });
}

const has = (event: string) => logs.some((l) => l.event === event);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hostd-life-edge-"));
  snapshotsDir = join(root, "snapshots");
  await mkdir(snapshotsDir);
  store = createVmStore(join(root, "vms"));
  logs = [];
  execCalls = [];
  execFail = () => undefined;
  infoStates = [];
  chState = "Shutdown";
  chOverrides = {};
  clockT = 1_000_000;
});

afterEach(async () => {
  await chmod(snapshotsDir, 0o700);
  await rm(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("VM lifecycle edges", () => {
  it("rejects each invalid spec field", async () => {
    const lifecycle = make();
    const bad: Array<Partial<CreateVmSpec>> = [
      { machineId: "has space" },
      { generation: -1 },
      { handle: "UPPER" },
      { tier: "gold" as CreateVmSpec["tier"] },
      { bootMiB: 2000 },
      { maxMiB: 2048 },
      { diskGiB: 0 },
      { userData: "x".repeat(64 * 1024 + 1) },
      { goldenVersion: "../etc" },
    ];
    for (const patch of bad) await expect(lifecycle.create({ ...spec, ...patch })).rejects.toMatchObject({ code: "invalid" });
  });

  it("logs a non-Error create failure through the default logger", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    execFail = (argv) => (argv[0] === "lvcreate" ? "lvcreate exploded" : undefined);
    const lifecycle = createVmLifecycle({
      store,
      exec,
      ch: () => ch(),
      pool: { freeBytes: async () => 1 },
      gatewayHealth: async () => true,
      trim: async () => undefined,
      config: { vmsDir: join(root, "vms"), snapshotsDir, serialLogDir: join(root, "log"), runDir: join(root, "run") },
    });
    await expect(lifecycle.create(spec)).rejects.toMatchObject({ code: "failed" });
    expect(error.mock.calls.some((c) => String(c[0]).includes('"error":"lvcreate exploded"'))).toBe(true);
  });

  it("refuses new VMs with busy beyond maxInFlight, and runs a queued op after a failed one", async () => {
    const lifecycle = make({}, { maxInFlight: 1 });
    const a = await lifecycle.create(spec);
    const b = await lifecycle.create({ ...spec, machineId: "machine-2", handle: "bob" });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = make({ trim: () => gate }, { maxInFlight: 1 });
    const suspending = slow.suspend(a.id);
    await expect(slow.stop(b.id)).rejects.toMatchObject({ code: "busy" });
    release();
    await suspending;

    const failing = make({ pool: { freeBytes: async () => 0 } });
    const results = await Promise.allSettled([failing.suspend(b.id), failing.stop(b.id)]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled"]);
  });

  it("fails with no_capacity when every private address is taken", async () => {
    const full: VmRecord[] = [];
    for (let n = 10; n <= 3 * 256 + 250; n += 1) {
      full.push({
        id: `vm_${n.toString(16).padStart(24, "0")}`,
        machineId: `m${n}`,
        generation: 1,
        handle: `h${n}`,
        tier: "free",
        state: "running",
        privateIPv4: `10.78.${n >> 8}.${n & 255}`,
        mac: "52:54:00:78:00:00",
        bootMiB: 2048,
        maxMiB: 8192,
        diskGiB: 20,
        chVersion: "v54.1",
        snapshot: null,
        updatedAt: "2026-11-21T00:00:00.000Z",
      });
    }
    const memory: VmStore = { ...store, list: async () => full, put: async () => undefined };
    await expect(make({ store: memory }).create(spec)).rejects.toMatchObject({ code: "no_capacity" });
  });

  it("restore keeps polling through Created and unreachable states, then resumes a paused VM", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    await lifecycle.suspend(vm.id);
    const resumes: string[] = [];
    chOverrides = {
      async resume() {
        resumes.push("resume");
      },
    };
    infoStates = ["Created", new ChError("unreachable", "x"), "Paused"];
    await expect(lifecycle.resume(vm.id, 1000)).resolves.toBe("running");
    expect(resumes).toEqual(["resume"]);
  });

  it("falls back to a cold boot when a restore errors or never comes up, and fails when the cold boot fails too", async () => {
    const lifecycle = make({}, { restoreTimeoutMs: 200 });
    const vm = await lifecycle.create(spec);
    await lifecycle.suspend(vm.id);
    infoStates = [new ChError("rejected", "x")];
    await expect(lifecycle.resume(vm.id, 100)).resolves.toBe("running");
    expect(has("vm_restore_failed")).toBe(true);

    await lifecycle.suspend(vm.id);
    chOverrides = { info: async () => Promise.reject(new ChError("unreachable", "down")) };
    execFail = (argv) => (argv[1] === "start" && argv[2]!.startsWith("matrix-vm@") ? 1 : undefined);
    await expect(lifecycle.resume(vm.id, 100)).rejects.toMatchObject({ code: "failed" });
    expect(has("vm_cold_boot_failed")).toBe(true);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "failed" });
  });

  it("start returns a running VM as is and refuses one still creating", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    await expect(lifecycle.start(vm.id)).resolves.toMatchObject({ state: "running" });
    await store.put({ ...(await store.get(vm.id))!, state: "creating" });
    await expect(lifecycle.start(vm.id)).rejects.toMatchObject({ code: "conflict" });
    await expect(lifecycle.setPolicy(vm.id, { tier: "paid", maxMiB: 16384 })).rejects.toMatchObject({ code: "conflict" });
  });

  it("logs a throwing health probe and keeps waiting", async () => {
    let calls = 0;
    const lifecycle = make({
      gatewayHealth: async () => {
        calls += 1;
        if (calls === 1) throw new Error("ECONNREFUSED");
        return true;
      },
    });
    const vm = await lifecycle.create(spec);
    await lifecycle.stop(vm.id);
    await expect(lifecycle.resume(vm.id, 2000)).resolves.toBe("running");
    expect(has("vm_health_probe_failed")).toBe(true);
  });

  it("suspend is a no-op when suspended, refuses a stopped VM, and survives a failing trim", async () => {
    const lifecycle = make({ trim: async () => Promise.reject(new Error("vsock gone")) });
    const vm = await lifecycle.create(spec);
    await expect(lifecycle.suspend(vm.id)).resolves.toMatchObject({ state: "suspended" });
    expect(has("vm_trim_failed")).toBe(true);
    await expect(lifecycle.suspend(vm.id)).resolves.toMatchObject({ state: "suspended" });
    await lifecycle.stop(vm.id);
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("a pause failure keeps the VM running without a resume", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    let resumed = false;
    chOverrides = {
      pause: async () => Promise.reject(new ChError("rejected", "x")),
      async resume() {
        resumed = true;
      },
    };
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "snapshot_failed" });
    expect(resumed).toBe(false);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "running" });
  });

  it("marks the VM failed when the new snapshot cannot be moved into place", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    chOverrides = {
      async snapshot(dir) {
        await writeFile(join(dir, "memory-ranges"), "mem");
        await chmod(snapshotsDir, 0o500);
      },
    };
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "failed" });
    expect(has("vm_snapshot_swap_failed")).toBe(true);
    await expect(store.get(vm.id)).resolves.toMatchObject({ state: "failed", snapshot: null });
  });

  it("keeps a suspend whose snapshot cannot be sparsified", async () => {
    execFail = (argv) => (argv[0] === "fallocate" ? 1 : undefined);
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    await expect(lifecycle.suspend(vm.id)).resolves.toMatchObject({ state: "suspended" });
    expect(has("vm_snapshot_sparsify_failed")).toBe(true);
  });

  it("stop waits for shutdown, tolerates an unreachable VMM, logs other power-button failures, and skips a stopped VM", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    chOverrides = { powerButton: async () => undefined };
    infoStates = ["Running", "Shutdown"];
    await expect(lifecycle.stop(vm.id)).resolves.toMatchObject({ state: "stopped" });

    await lifecycle.start(vm.id);
    chOverrides = { powerButton: async () => Promise.reject(new ChError("unreachable", "x")) };
    await lifecycle.stop(vm.id);
    expect(has("vm_power_button_failed")).toBe(false);

    await lifecycle.start(vm.id);
    chOverrides = { powerButton: async () => Promise.reject(new ChError("rejected", "x")) };
    await lifecycle.stop(vm.id);
    expect(has("vm_power_button_failed")).toBe(true);

    logs = [];
    execCalls = [];
    await expect(lifecycle.stop(vm.id)).resolves.toMatchObject({ state: "stopped" });
    expect(execCalls.map((c) => c[0])).toEqual(["systemctl"]);
  });

  it("destroy ignores an invalid id", async () => {
    await expect(make().destroy("../etc")).resolves.toBeUndefined();
    expect(execCalls).toEqual([]);
  });
});

describe("repeated create never destroys a VM that has a real disk", () => {
  const destroyed = () => execCalls.some((c) => c[0] === "lvremove" || (c[0] === "systemctl" && c[1] === "stop"));

  async function expectKept(lifecycle: VmLifecycle, id: string) {
    execCalls = [];
    await expect(lifecycle.create(spec)).rejects.toMatchObject({ code: "conflict" });
    expect(destroyed()).toBe(false);
    await expect(store.get(id)).resolves.toMatchObject({ id, state: "failed" });
  }

  it("keeps a VM that failed during a resume whose cold boot failed", async () => {
    const lifecycle = make({}, { restoreTimeoutMs: 200 });
    const vm = await lifecycle.create(spec);
    await lifecycle.suspend(vm.id);
    chOverrides = { info: async () => Promise.reject(new ChError("unreachable", "down")) };
    execFail = (argv) => (argv[1] === "start" && argv[2]!.startsWith("matrix-vm@") ? 1 : undefined);
    await expect(lifecycle.resume(vm.id, 100)).rejects.toMatchObject({ code: "failed" });
    execFail = () => undefined;
    await expectKept(lifecycle, vm.id);
  });

  it("keeps a VM left paused by a failed snapshot", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    chOverrides = {
      snapshot: async () => Promise.reject(new ChError("rejected", "x")),
      resume: async () => Promise.reject(new ChError("rejected", "x")),
    };
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "snapshot_failed" });
    chOverrides = {};
    await expectKept(lifecycle, vm.id);
  });

  it("keeps a VM whose snapshot swap failed", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    chOverrides = {
      async snapshot(dir) {
        await writeFile(join(dir, "memory-ranges"), "mem");
        await chmod(snapshotsDir, 0o500);
      },
    };
    await expect(lifecycle.suspend(vm.id)).rejects.toMatchObject({ code: "failed" });
    await chmod(snapshotsDir, 0o700);
    chOverrides = {};
    await expectKept(lifecycle, vm.id);
  });

  it("keeps a VM failed by reconcile after an interrupted suspend, but recreates one reconciled from creating", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    await store.put({ ...(await store.get(vm.id))!, state: "suspending" });
    const inactive: Exec = async () => ({ code: 3, stdout: "", stderr: "" });
    await reconcileVms({ store, exec: inactive, ch: () => ch(), snapshotsDir, log: () => undefined });
    await expectKept(lifecycle, vm.id);

    const other = { ...spec, machineId: "machine-2", handle: "bob" };
    const second = await lifecycle.create(other);
    await store.put({ ...(await store.get(second.id))!, state: "creating" });
    await reconcileVms({ store, exec: inactive, ch: () => ch(), snapshotsDir, log: () => undefined });
    await expect(store.get(second.id)).resolves.toMatchObject({ state: "failed", failedDuring: "create" });
    const again = await lifecycle.create(other);
    expect(again.id).not.toBe(second.id);
    await expect(store.get(second.id)).resolves.toBeNull();
  });

  it("marks a failed create, and clears the marker once the VM runs", async () => {
    execFail = (argv) => (argv[0] === "lvcreate" ? 5 : undefined);
    const lifecycle = make();
    await expect(lifecycle.create(spec)).rejects.toMatchObject({ code: "failed" });
    const [failed] = await store.list();
    expect(failed).toMatchObject({ state: "failed", failedDuring: "create" });
    execFail = () => undefined;
    const started = await lifecycle.start(failed!.id);
    expect(started.failedDuring).toBeUndefined();
  });
});

describe("free-tier limits", () => {
  it("rejects a free VM that is not booted at 2048 MiB, exceeds 8192 MiB, or exceeds 20 GiB", async () => {
    const lifecycle = make();
    for (const patch of [{ bootMiB: 1024 }, { bootMiB: 4096 }, { maxMiB: 8320 }, { diskGiB: 21 }]) {
      await expect(lifecycle.create({ ...spec, ...patch })).rejects.toMatchObject({ code: "invalid" });
    }
    await expect(lifecycle.create({ ...spec, tier: "paid", bootMiB: 4096, maxMiB: 131072, diskGiB: 200 })).resolves.toMatchObject({
      state: "running",
    });
    await expect(
      lifecycle.create({ ...spec, machineId: "m-big", handle: "big", tier: "paid", maxMiB: 131200 }),
    ).rejects.toMatchObject({ code: "invalid" });
  });

  it("refuses to raise a free VM above 8192 MiB and a paid VM above 128 GiB", async () => {
    const lifecycle = make();
    const vm = await lifecycle.create(spec);
    await expect(lifecycle.setPolicy(vm.id, { tier: "free", maxMiB: 8320 })).rejects.toMatchObject({ code: "invalid" });
    await expect(lifecycle.setPolicy(vm.id, { tier: "paid", maxMiB: 131200 })).rejects.toMatchObject({ code: "invalid" });
    await expect(lifecycle.setPolicy(vm.id, { tier: "paid", maxMiB: 131072 })).resolves.toMatchObject({ maxMiB: 131072 });
  });
});
