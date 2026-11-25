import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { ChClient } from "./ch-client.js";
import type { GuestClient } from "./guest-client.js";
import type { VmRecord, VmStore, VmTier } from "./vm-store.js";
import type { AutomaticResize } from "./vm-lifecycle.js";

// Memory controller: every interval, samples each running VM (guest agent
// stats plus Cloud Hypervisor's actual memory size) and hotplugs or unplugs
// virtio-mem in 1 GiB steps. decideMemory is the whole policy; the loop only
// gathers inputs, spends host headroom, and never throws.

export interface MemorySample {
  psiSome10: number;
  availableMiB: number;
  actualMiB: number;
  idleSeconds: number;
}

export interface MemoryPolicy {
  bootMiB: number;
  maxMiB: number;
  tier: VmTier;
  hostAvailableMiB: number;
}

export interface MemoryDecision {
  action: "grow" | "shrink" | "none";
  targetMiB: number;
}

export const MEMORY_STEP_MIB = 1024;
export const GROW_PSI_SOME10 = 10;
export const GROW_AVAILABLE_FRACTION = 0.15;
export const HOST_RESERVE_MIB = 32_768;
export const SHRINK_IDLE_SECONDS = 600;
export const SHRINK_AVAILABLE_FRACTION = 0.5;

export function decideMemory(sample: MemorySample, policy: MemoryPolicy): MemoryDecision {
  const { actualMiB } = sample;
  if (
    sample.psiSome10 > GROW_PSI_SOME10 &&
    sample.availableMiB < actualMiB * GROW_AVAILABLE_FRACTION &&
    policy.hostAvailableMiB >= HOST_RESERVE_MIB &&
    actualMiB < policy.maxMiB
  ) {
    return { action: "grow", targetMiB: Math.min(actualMiB + MEMORY_STEP_MIB, policy.maxMiB) };
  }
  if (
    policy.tier === "free" &&
    sample.idleSeconds >= SHRINK_IDLE_SECONDS &&
    sample.availableMiB > actualMiB * SHRINK_AVAILABLE_FRACTION &&
    actualMiB > policy.bootMiB
  ) {
    return { action: "shrink", targetMiB: Math.max(actualMiB - MEMORY_STEP_MIB, policy.bootMiB) };
  }
  return { action: "none", targetMiB: actualMiB };
}

const MIB = 1024 * 1024;

export async function readHostAvailableMiB(signal: AbortSignal, path = "/proc/meminfo"): Promise<number> {
  const meminfo = await readFile(path, { encoding: "utf8", signal });
  const match = /^MemAvailable:\s+(\d+) kB$/m.exec(meminfo);
  if (match === null) throw new RangeError("meminfo has no MemAvailable");
  return Math.floor(Number(match[1]) / 1024);
}

export interface MemoryControllerDeps {
  store: Pick<VmStore, "list" | "get">;
  // Each returns a fresh client; the controller closes CH clients after use.
  ch: (id: string) => ChClient;
  guest: (id: string) => Pick<GuestClient, "stats">;
  // The lifecycle's resize op: it runs in the VM's operation queue, so a
  // resize can never race a suspend or a restore.
  resize: (id: string, targetMiB: number, automatic: AutomaticResize) => Promise<void>;
  hostAvailableMiB?: (signal: AbortSignal) => Promise<number>;
  // Seconds since the owner last interacted with the VM (wired in H5/P6).
  idleSeconds?: (record: VmRecord) => number | Promise<number>;
  log?: (event: string, fields: Record<string, unknown>) => void;
  intervalMs?: number;
  concurrency?: number;
  opTimeoutMs?: number;
}

export interface MemoryController {
  start(): void;
  stop(): Promise<void>;
  tick(): Promise<void>;
}

const errorFields = (error: unknown) =>
  error instanceof Error
    ? { error: error.name, message: error.message, code: (error as { code?: unknown }).code }
    : { error: String(error) };

const isAbort = (error: unknown) => error instanceof Error && error.name === "AbortError";

export function createMemoryController(deps: MemoryControllerDeps): MemoryController {
  const intervalMs = deps.intervalMs ?? 5_000;
  const concurrency = Math.max(1, deps.concurrency ?? 8);
  const opTimeoutMs = deps.opTimeoutMs ?? 3_000;
  const hostAvailable = deps.hostAvailableMiB ?? ((signal: AbortSignal) => readHostAvailableMiB(signal));
  const idleSeconds = deps.idleSeconds ?? (() => 0);
  const log = deps.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const stopper = new AbortController();
  let loop: Promise<void> | null = null;

  const opSignal = () => AbortSignal.any([stopper.signal, AbortSignal.timeout(opTimeoutMs)]);

  async function readIdle(record: VmRecord): Promise<number> {
    try {
      const value = await idleSeconds(record);
      return Number.isFinite(value) && value > 0 ? value : 0;
    } catch (error: unknown) {
      log("memory.idle_read_failed", { id: record.id, ...errorFields(error) });
      return 0;
    }
  }

  async function sampleVm(record: VmRecord, budget: { mib: number }): Promise<void> {
    // Everything, including the client factory, stays inside the try: one VM's
    // failure must never reject the tick or the loop.
    let ch: ChClient | undefined;
    let reservedMiB = 0;
    try {
      ch = deps.ch(record.id);
      const info = await ch.info(opSignal());
      if (info.state !== "Running") return;
      const stats = await deps.guest(record.id).stats(opSignal());
      const actualMiB = Math.floor(info.memoryActualBytes / MIB);
      const idleSeconds = await readIdle(record);
      const current = await deps.store.get(record.id);
      if (current?.state !== "running") return;
      const { bootMiB, maxMiB, tier } = current;
      const decision = decideMemory(
        { psiSome10: stats.psiSome10, availableMiB: stats.availableMiB, actualMiB, idleSeconds },
        { bootMiB, maxMiB, tier, hostAvailableMiB: budget.mib },
      );
      if (decision.action === "none") return;
      // Spend the headroom before awaiting, so concurrent samples see it.
      if (decision.action === "grow") reservedMiB = decision.targetMiB - actualMiB;
      budget.mib -= reservedMiB;
      await deps.resize(record.id, decision.targetMiB, { tier, maxMiB, action: decision.action });
      reservedMiB = 0;
      log("memory.resized", { id: record.id, action: decision.action, fromMiB: actualMiB, toMiB: decision.targetMiB });
    } catch (error: unknown) {
      budget.mib += reservedMiB;
      log("memory.sample_failed", { id: record.id, ...errorFields(error) });
    } finally {
      if (ch !== undefined) {
        try {
          await ch.close();
        } catch (error: unknown) {
          log("memory.ch_close_failed", { id: record.id, ...errorFields(error) });
        }
      }
    }
  }

  async function tick(): Promise<void> {
    let records: VmRecord[];
    try {
      records = (await deps.store.list()).filter((r) => r.state === "running");
    } catch (error: unknown) {
      log("memory.list_failed", errorFields(error));
      return;
    }
    if (records.length === 0) return;
    const budget = { mib: 0 };
    try {
      budget.mib = await hostAvailable(opSignal());
    } catch (error: unknown) {
      // Unknown host headroom: shrink only, never grow.
      log("memory.host_read_failed", errorFields(error));
    }
    let next = 0;
    const worker = async () => {
      while (next < records.length && !stopper.signal.aborted) {
        const record = records[next];
        next += 1;
        await sampleVm(record, budget);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, records.length) }, worker));
  }

  async function run(): Promise<void> {
    while (!stopper.signal.aborted) {
      const started = Date.now();
      await tick();
      try {
        await delay(Math.max(0, intervalMs - (Date.now() - started)), undefined, { signal: stopper.signal });
      } catch (error: unknown) {
        if (!isAbort(error)) log("memory.loop_failed", errorFields(error));
        return;
      }
    }
  }

  return {
    start() {
      if (loop !== null || stopper.signal.aborted) return;
      loop = run();
    },
    async stop() {
      stopper.abort();
      await loop;
    },
    tick,
  };
}
