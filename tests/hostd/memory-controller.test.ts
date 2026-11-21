import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChClient, ChVmInfo } from "../../packages/hostd/src/ch-client.js";
import type { GuestStats } from "../../packages/hostd/src/guest-client.js";
import {
  createMemoryController,
  decideMemory,
  readHostAvailableMiB,
  type MemoryControllerDeps,
} from "../../packages/hostd/src/memory-controller.js";
import type { VmRecord, VmState, VmTier } from "../../packages/hostd/src/vm-store.js";

const MiB = 1024 * 1024;
const FREE = { bootMiB: 2048, maxMiB: 8192, tier: "free" as const, hostAvailableMiB: 65536 };
const PAID = { ...FREE, tier: "paid" as const };

describe("decideMemory", () => {
  it("grows by 1024 MiB when psiSome10 > 10 and available < 15% of actual, capped at maxMiB", () => {
    expect(decideMemory({ psiSome10: 10.5, availableMiB: 300, actualMiB: 2048, idleSeconds: 0 }, FREE)).toEqual({
      action: "grow",
      targetMiB: 3072,
    });
    expect(decideMemory({ psiSome10: 40, availableMiB: 100, actualMiB: 7680, idleSeconds: 0 }, FREE)).toEqual({
      action: "grow",
      targetMiB: 8192,
    });
    expect(decideMemory({ psiSome10: 40, availableMiB: 100, actualMiB: 8192, idleSeconds: 0 }, FREE)).toEqual({
      action: "none",
      targetMiB: 8192,
    });
    // Pressure alone, or low available memory alone, is not enough.
    expect(decideMemory({ psiSome10: 10, availableMiB: 100, actualMiB: 2048, idleSeconds: 0 }, FREE).action).toBe(
      "none",
    );
    expect(decideMemory({ psiSome10: 50, availableMiB: 400, actualMiB: 2048, idleSeconds: 0 }, FREE).action).toBe(
      "none",
    );
    // Paid VMs grow the same way.
    expect(decideMemory({ psiSome10: 50, availableMiB: 100, actualMiB: 2048, idleSeconds: 0 }, PAID).action).toBe(
      "grow",
    );
  });

  it("never grows when hostAvailableMiB < 32768", () => {
    const sample = { psiSome10: 90, availableMiB: 10, actualMiB: 2048, idleSeconds: 0 };
    expect(decideMemory(sample, { ...FREE, hostAvailableMiB: 32767 })).toEqual({ action: "none", targetMiB: 2048 });
    expect(decideMemory(sample, { ...PAID, hostAvailableMiB: 1024 })).toEqual({ action: "none", targetMiB: 2048 });
    expect(decideMemory(sample, { ...FREE, hostAvailableMiB: 32768 }).action).toBe("grow");
  });

  it("shrinks toward bootMiB in 1024 MiB steps when idleSeconds >= 600 and available > 50% of actual", () => {
    expect(decideMemory({ psiSome10: 0, availableMiB: 3000, actualMiB: 4096, idleSeconds: 600 }, FREE)).toEqual({
      action: "shrink",
      targetMiB: 3072,
    });
    expect(decideMemory({ psiSome10: 0, availableMiB: 2000, actualMiB: 2560, idleSeconds: 900 }, FREE)).toEqual({
      action: "shrink",
      targetMiB: 2048,
    });
    expect(decideMemory({ psiSome10: 0, availableMiB: 1800, actualMiB: 2048, idleSeconds: 900 }, FREE)).toEqual({
      action: "none",
      targetMiB: 2048,
    });
    expect(decideMemory({ psiSome10: 0, availableMiB: 3000, actualMiB: 4096, idleSeconds: 599 }, FREE).action).toBe(
      "none",
    );
    expect(decideMemory({ psiSome10: 0, availableMiB: 2048, actualMiB: 4096, idleSeconds: 3600 }, FREE).action).toBe(
      "none",
    );
  });

  it("paid tier never shrinks", () => {
    expect(decideMemory({ psiSome10: 0, availableMiB: 7000, actualMiB: 8192, idleSeconds: 86_400 }, PAID)).toEqual({
      action: "none",
      targetMiB: 8192,
    });
  });
});

describe("readHostAvailableMiB", () => {
  it("reads MemAvailable from a meminfo file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hostd-meminfo-"));
    try {
      const path = join(dir, "meminfo");
      await writeFile(path, "MemTotal: 134217728 kB\nMemAvailable:   67108864 kB\n");
      await expect(readHostAvailableMiB(AbortSignal.timeout(1_000), path)).resolves.toBe(65536);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

interface VmFixture {
  record: VmRecord;
  actualMiB: number;
  stats: GuestStats | Error;
  chState?: ChVmInfo["state"];
}

function record(id: string, tier: VmTier = "free", state: VmState = "running"): VmRecord {
  return {
    id,
    machineId: `m-${id}`,
    generation: 1,
    handle: id,
    tier,
    state,
    privateIPv4: "10.0.0.2",
    mac: "02:00:00:00:00:02",
    bootMiB: 2048,
    maxMiB: 8192,
    diskGiB: 20,
    chVersion: "54.1",
    snapshot: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
  };
}

const PRESSURED: GuestStats = { psiSome10: 50, availableMiB: 100, anonMiB: 1800 };
const IDLE: GuestStats = { psiSome10: 0, availableMiB: 3500, anonMiB: 300 };

interface Harness {
  deps: MemoryControllerDeps;
  resizes: Array<{ id: string; bytes: number }>;
  closes: string[];
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  inFlight: { now: number; max: number };
}

function harness(fixtures: VmFixture[], overrides: Partial<MemoryControllerDeps> = {}): Harness {
  const byId = new Map(fixtures.map((f) => [f.record.id, f]));
  const resizes: Harness["resizes"] = [];
  const closes: string[] = [];
  const logs: Harness["logs"] = [];
  const inFlight = { now: 0, max: 0 };
  const deps: MemoryControllerDeps = {
    store: {
      async list() {
        return fixtures.map((f) => f.record);
      },
      async get(id) {
        return byId.get(id)?.record ?? null;
      },
    },
    ch(id) {
      const fixture = byId.get(id)!;
      const unused = async () => {
        throw new Error("unused");
      };
      const client: ChClient = {
        async info() {
          return { state: fixture.chState ?? "Running", memoryActualBytes: fixture.actualMiB * MiB };
        },
        resizeMemory: unused,
        pause: unused,
        resume: unused,
        snapshot: unused,
        powerButton: unused,
        shutdownVmm: unused,
        async close() {
          closes.push(id);
        },
      };
      return client;
    },
    guest(id) {
      return {
        async stats() {
          inFlight.now += 1;
          inFlight.max = Math.max(inFlight.max, inFlight.now);
          await new Promise((r) => setTimeout(r, 5));
          inFlight.now -= 1;
          const stats = byId.get(id)!.stats;
          if (stats instanceof Error) throw stats;
          return stats;
        },
      };
    },
    async resize(id, targetMiB) {
      resizes.push({ id, bytes: targetMiB * MiB });
    },
    hostAvailableMiB: async () => 65536,
    log: (event, fields) => logs.push({ event, fields }),
    ...overrides,
  };
  return { deps, resizes, closes, logs, inFlight };
}

describe("memory controller loop", () => {
  it("resizes a pressured running VM by one step and skips VMs that are not running", async () => {
    const h = harness([
      { record: record("vm_a"), actualMiB: 2048, stats: PRESSURED },
      { record: record("vm_b", "free", "suspending"), actualMiB: 2048, stats: PRESSURED },
      { record: record("vm_c"), actualMiB: 2048, stats: PRESSURED, chState: "Paused" },
    ]);
    await createMemoryController(h.deps).tick();
    expect(h.resizes).toEqual([{ id: "vm_a", bytes: 3072 * MiB }]);
    expect(h.closes.sort()).toEqual(["vm_a", "vm_c"]);
  });

  it("shrinks only with idle seconds from the injected source, defaulting to 0", async () => {
    const fixtures = [{ record: record("vm_a"), actualMiB: 4096, stats: IDLE }];
    const noIdle = harness(fixtures);
    await createMemoryController(noIdle.deps).tick();
    expect(noIdle.resizes).toEqual([]);

    const idle = harness(fixtures, { idleSeconds: async () => 900 });
    await createMemoryController(idle.deps).tick();
    expect(idle.resizes).toEqual([{ id: "vm_a", bytes: 3072 * MiB }]);
  });

  it("logs a failing VM and still serves the others", async () => {
    const h = harness([
      { record: record("vm_a"), actualMiB: 2048, stats: new Error("guest gone") },
      { record: record("vm_b"), actualMiB: 2048, stats: PRESSURED },
    ]);
    await expect(createMemoryController(h.deps).tick()).resolves.toBeUndefined();
    expect(h.resizes).toEqual([{ id: "vm_b", bytes: 3072 * MiB }]);
    expect(h.logs.some((l) => l.event === "memory.sample_failed" && l.fields.id === "vm_a")).toBe(true);
    expect(h.closes.sort()).toEqual(["vm_a", "vm_b"]);
  });

  it("logs a VM whose CH client factory throws and still serves the others", async () => {
    const h = harness([
      { record: record("vm_a"), actualMiB: 2048, stats: PRESSURED },
      { record: record("vm_b"), actualMiB: 2048, stats: PRESSURED },
    ]);
    const factory = h.deps.ch;
    h.deps.ch = (id) => {
      if (id === "vm_a") throw new Error("bad socket path");
      return factory(id);
    };
    await expect(createMemoryController(h.deps).tick()).resolves.toBeUndefined();
    expect(h.resizes).toEqual([{ id: "vm_b", bytes: 3072 * MiB }]);
    expect(h.logs.some((l) => l.event === "memory.sample_failed" && l.fields.id === "vm_a")).toBe(true);
  });

  it("spends host headroom across VMs within one tick", async () => {
    const h = harness(
      [
        { record: record("vm_a"), actualMiB: 2048, stats: PRESSURED },
        { record: record("vm_b"), actualMiB: 2048, stats: PRESSURED },
      ],
      { hostAvailableMiB: async () => 33000, concurrency: 1 },
    );
    await createMemoryController(h.deps).tick();
    expect(h.resizes).toHaveLength(1);
  });

  it("never grows when host memory cannot be read", async () => {
    const h = harness([{ record: record("vm_a"), actualMiB: 2048, stats: PRESSURED }], {
      hostAvailableMiB: async () => {
        throw new Error("EIO");
      },
    });
    await createMemoryController(h.deps).tick();
    expect(h.resizes).toEqual([]);
    expect(h.logs.some((l) => l.event === "memory.host_read_failed")).toBe(true);
  });

  it("skips the resize when the VM left running during the sample", async () => {
    const fixture: VmFixture = { record: record("vm_a"), actualMiB: 2048, stats: PRESSURED };
    const h = harness([fixture], {});
    const list = h.deps.store.list;
    h.deps.store.list = async () => {
      const records = await list();
      fixture.record = { ...fixture.record, state: "suspending" };
      return records.map((r) => ({ ...r, state: "running" as const }));
    };
    await createMemoryController(h.deps).tick();
    expect(h.resizes).toEqual([]);
  });

  it("resizes through the lifecycle op and logs its refusal", async () => {
    const h = harness([{ record: record("vm_a"), actualMiB: 2048, stats: PRESSURED }], {
      async resize() {
        throw Object.assign(new Error("VM is suspending"), { code: "conflict" });
      },
    });
    await expect(createMemoryController(h.deps).tick()).resolves.toBeUndefined();
    expect(h.logs.some((l) => l.event === "memory.sample_failed" && l.fields.code === "conflict")).toBe(true);
  });

  it("bounds concurrent samples", async () => {
    const fixtures = Array.from({ length: 6 }, (_, i) => ({
      record: record(`vm_${i}`),
      actualMiB: 2048,
      stats: IDLE,
    }));
    const h = harness(fixtures, { concurrency: 2 });
    await createMemoryController(h.deps).tick();
    expect(h.inFlight.max).toBe(2);
  });

  it("samples on an interval and stops cleanly", async () => {
    let ticks = 0;
    const h = harness([{ record: record("vm_a"), actualMiB: 2048, stats: IDLE }]);
    const list = h.deps.store.list;
    h.deps.store.list = async () => {
      ticks += 1;
      return list();
    };
    const controller = createMemoryController({ ...h.deps, intervalMs: 10 });
    controller.start();
    await new Promise((r) => setTimeout(r, 80));
    await controller.stop();
    const seen = ticks;
    expect(seen).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 40));
    expect(ticks).toBe(seen);
  });
});
