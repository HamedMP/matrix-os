import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChClient, ChVmState } from "../../packages/hostd/src/ch-client.js";
import type { Exec } from "../../packages/hostd/src/exec.js";
import { fitsVmMemory } from "../../packages/hostd/src/memory-admission.js";
import { reconcileVms } from "../../packages/hostd/src/reconcile.js";
import { createVmStore, type VmRecord, type VmState, type VmStore } from "../../packages/hostd/src/vm-store.js";

let root: string;
let snapshotsDir: string;
let store: VmStore;
let active: Set<string>;
let execCalls: string[][];
let execThrows: boolean;
let chState: ChVmState;
let chEvents: string[];

const ID = "vm_0123456789abcdef01234567";
const UPDATED = "2026-11-21T10:00:00.000Z";

function record(state: VmState, overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: ID,
    machineId: "machine-1",
    generation: 1,
    handle: "alice",
    tier: "free",
    state,
    privateIPv4: "10.78.0.10",
    mac: "52:54:00:78:00:0a",
    bootMiB: 2048,
    maxMiB: 8192,
    diskGiB: 20,
    chVersion: "v54.1",
    snapshot: null,
    updatedAt: UPDATED,
    ...overrides,
  };
}

const exec: Exec = async (argv) => {
  execCalls.push([...argv]);
  if (execThrows) throw new Error("spawn systemctl ENOENT");
  const unit = argv[2]!;
  return { code: active.has(unit) ? 0 : 3, stdout: active.has(unit) ? "active\n" : "inactive\n", stderr: "" };
};

function ch(): ChClient {
  const unused = async () => {
    throw new Error("unused");
  };
  return {
    async info() {
      chEvents.push("info");
      return { state: chState, memoryActualBytes: 2048 * 1024 * 1024 };
    },
    async resume() {
      chEvents.push("resume");
      chState = "Running";
    },
    pause: unused,
    snapshot: unused,
    resizeMemory: unused,
    powerButton: unused,
    shutdownVmm: unused,
    async close() {
      chEvents.push("close");
    },
  };
}

async function writeSnapshot(takenAt: string): Promise<string> {
  const dir = join(snapshotsDir, ID);
  await mkdir(dir, { recursive: true });
  for (const name of ["state.json", "memory-ranges", "config.json"]) {
    await writeFile(join(dir, name), "x");
    const t = new Date(takenAt);
    await utimes(join(dir, name), t, t);
  }
  return dir;
}

const run = () => reconcileVms({ store, exec, ch: () => ch(), snapshotsDir, log: () => undefined });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hostd-reconcile-"));
  snapshotsDir = join(root, "snapshots");
  store = createVmStore(join(root, "vms"));
  active = new Set();
  execCalls = [];
  execThrows = false;
  chState = "Running";
  chEvents = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("startup reconciliation", () => {
  it("marks a creating VM whose unit is active as running", async () => {
    await store.put(record("creating"));
    active.add(`matrix-vm@${ID}.service`);
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "running" });
    expect(execCalls).toContainEqual(["systemctl", "is-active", `matrix-vm@${ID}.service`]);
  });

  it("marks a resuming VM whose restore unit is active as running", async () => {
    await store.put(record("resuming"));
    active.add(`matrix-vm-restore@${ID}.service`);
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "running" });
  });

  it("resumes a VM left paused by an interrupted suspend", async () => {
    await store.put(record("suspending"));
    active.add(`matrix-vm@${ID}.service`);
    chState = "Paused";
    await run();
    expect(chEvents).toEqual(["info", "resume", "close"]);
    await expect(store.get(ID)).resolves.toMatchObject({ state: "running" });
  });

  it("marks an inactive suspending VM with a snapshot taken after the suspend began as suspended", async () => {
    await store.put(record("suspending"));
    const dir = await writeSnapshot("2026-11-21T10:00:05.000Z");
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({
      state: "suspended",
      snapshot: { dir, chVersion: "v54.1", takenAt: "2026-11-21T10:00:05.000Z" },
    });
  });

  it("marks an inactive VM with only an older or incomplete snapshot as failed", async () => {
    await store.put(record("suspending"));
    await writeSnapshot("2026-11-21T09:00:00.000Z");
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "failed" });

    await store.put(record("resuming"));
    await rm(join(snapshotsDir, ID, "memory-ranges"));
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "failed" });
  });

  it("marks an inactive creating VM as failed", async () => {
    await store.put(record("creating"));
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "failed" });
  });

  it("marks a VM failed when systemd cannot be queried", async () => {
    await store.put(record("creating"));
    execThrows = true;
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "failed" });
  });

  it("treats a snapshot entry that is not a file as incomplete", async () => {
    await store.put(record("suspending"));
    await mkdir(join(snapshotsDir, ID, "state.json"), { recursive: true });
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "failed" });
  });

  it("marks an active VM stopped, so a wake cold-boots it, when Cloud Hypervisor cannot be asked about a pause", async () => {
    await store.put(record("suspending"));
    active.add(`matrix-vm@${ID}.service`);
    const logs: string[] = [];
    const failing = (): ChClient => ({ ...ch(), info: async () => Promise.reject(new Error("socket gone")) });
    await reconcileVms({ store, exec, ch: failing, snapshotsDir, log: (event) => logs.push(event) });
    await expect(store.get(ID)).resolves.toMatchObject({ state: "stopped", snapshot: null });
    expect(logs).toContain("reconcile.unpause_failed");
    expect(chEvents).toEqual(["close"]);
  });

  it("marks a paused VM stopped, not running, when its resume request fails", async () => {
    await store.put(record("resuming", { snapshot: { dir: "/s", takenAt: UPDATED, chVersion: "v54.1" } }));
    active.add(`matrix-vm-restore@${ID}.service`);
    chState = "Paused";
    const failing = (): ChClient => ({ ...ch(), resume: async () => Promise.reject(new Error("resume refused")) });
    await reconcileVms({ store, exec, ch: failing, snapshotsDir, log: () => undefined });
    await expect(store.get(ID)).resolves.toMatchObject({ state: "stopped", snapshot: null });
  });

  it.each([8192, undefined])("reclaims failed VM RAM after both units stop (reservation %s)", async (reservation) => {
    await store.put(record("failed", { failedDuring: "create", memoryReservationMiB: reservation }));
    expect(fitsVmMemory(10_000, await store.list(), undefined, 8192)).toBe(false);

    await run();

    expect(fitsVmMemory(10_000, await store.list(), undefined, 8192)).toBe(true);
    expect(await store.get(ID)).toMatchObject({ id: ID, state: "failed", failedDuring: "create" });
    expect(execCalls).toEqual([
      ["systemctl", "is-active", `matrix-vm@${ID}.service`],
      ["systemctl", "is-active", `matrix-vm-restore@${ID}.service`],
    ]);
  });

  it("keeps a failed VM's reservation when its restore unit is active or systemd is unavailable", async () => {
    await store.put(record("failed", { memoryReservationMiB: 8192 }));
    active.add(`matrix-vm-restore@${ID}.service`);
    await run();
    expect(fitsVmMemory(10_000, await store.list(), undefined, 8192)).toBe(false);

    active.clear();
    const busyBus: Exec = async () => ({ code: 1, stdout: "", stderr: "bus unavailable" });
    await reconcileVms({ store, exec: busyBus, ch: () => ch(), snapshotsDir, log: () => undefined });
    expect(fitsVmMemory(10_000, await store.list(), undefined, 8192)).toBe(false);
  });

  it("marks a running record whose units are inactive (host reboot, crash mid-stop) stopped", async () => {
    await store.put(record("running", { snapshot: { dir: "/s", takenAt: UPDATED, chVersion: "v54.1" } }));
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "stopped", snapshot: null });
    expect(execCalls).toEqual([
      ["systemctl", "is-active", `matrix-vm@${ID}.service`],
      ["systemctl", "is-active", `matrix-vm-restore@${ID}.service`],
    ]);
  });

  it("keeps a live reservation when systemd returns a query error", async () => {
    await store.put(record("running", { memoryReservationMiB: 8192 }));
    const badBus: Exec = async () => ({ code: 1, stdout: "", stderr: "bus unavailable" });
    await reconcileVms({ store, exec: badBus, ch: () => ch(), snapshotsDir, log: () => undefined });
    await expect(store.get(ID)).resolves.toMatchObject({ state: "running", memoryReservationMiB: 8192 });
  });

  it("leaves a running record alone when its unit is active or systemd cannot be queried", async () => {
    await store.put(record("running"));
    active.add(`matrix-vm@${ID}.service`);
    await run();
    await expect(store.get(ID)).resolves.toMatchObject({ state: "running", updatedAt: UPDATED });

    active.clear();
    execThrows = true;
    const logs: string[] = [];
    await reconcileVms({ store, exec, ch: () => ch(), snapshotsDir, log: (event) => logs.push(event) });
    await expect(store.get(ID)).resolves.toMatchObject({ state: "running", updatedAt: UPDATED });
    expect(logs).toContain("reconcile.query_failed");
    expect(chEvents).toEqual([]);
  });

  it("leaves settled records alone", async () => {
    for (const [i, state] of (["running", "suspended", "stopped", "failed"] as const).entries()) {
      await store.put(record(state, {
        id: `vm_${String(i).repeat(24)}`,
        memoryReservationMiB: state === "failed" ? null : undefined,
      }));
    }
    active.add(`matrix-vm@vm_${"0".repeat(24)}.service`);
    await run();
    expect(execCalls).toEqual([["systemctl", "is-active", `matrix-vm@vm_${"0".repeat(24)}.service`]]);
    expect((await store.list()).map((r) => r.updatedAt)).toEqual([UPDATED, UPDATED, UPDATED, UPDATED]);
  });
});
