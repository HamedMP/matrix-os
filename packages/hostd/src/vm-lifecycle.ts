import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChError, type ChClient } from "./ch-client.js";
import { run, type Exec } from "./exec.js";
import { isVmId, writeFileAtomic, type VmRecord, type VmStore, type VmTier } from "./vm-store.js";

// VM lifecycle on one metal host: create (thin clone of the golden LV plus a
// cloud-init seed), suspend (trim, snapshot, stop), resume (ondemand restore),
// stop, destroy. Exactly one operation runs per VM id; a caller asking for the
// operation already at the tail of that VM's queue joins it, any other
// operation waits for the queue to drain.

export interface CreateVmSpec {
  machineId: string;
  generation: number;
  handle: string;
  tier: VmTier;
  bootMiB: number;
  maxMiB: number;
  diskGiB: number;
  userData: string;
  goldenVersion: string;
}

export interface LifecycleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: LifecycleClock = { now: () => Date.now(), sleep: (ms) => delay(ms) };

export interface LifecycleConfig {
  vmsDir: string;
  snapshotsDir: string;
  serialLogDir: string;
  runDir: string;
  volumeGroup: string;
  kernelPath: string;
  initramfsPath: string;
  kernelCmdline: string;
  chVersion: string;
  vcpus: number;
  bridge: string;
  gatewayIPv4: string;
  prefixLength: number;
  nameservers: readonly string[];
  vmUser: string;
  // Group that may traverse a VM's state directory to open its seed image.
  vmGroup: string;
  execTimeoutMs: number;
  chTimeoutMs: number;
  restoreTimeoutMs: number;
  stopGraceMs: number;
  trimSettleMs: number;
  maxInFlight: number;
}

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  vmsDir: "/var/lib/matrix-hostd/vms",
  snapshotsDir: "/var/lib/matrix-hostd/snapshots",
  serialLogDir: "/var/log/matrix-vm",
  runDir: "/run/matrix-vm",
  volumeGroup: "vmvg",
  kernelPath: "/var/lib/matrix-hostd/kernel/vmlinuz",
  initramfsPath: "/var/lib/matrix-hostd/kernel/initrd.img",
  kernelCmdline:
    "console=ttyS0 root=LABEL=cloudimg-rootfs rw memhp_default_state=online " +
    "memory_hotplug.online_policy=auto-movable page_reporting.page_reporting_order=5",
  chVersion: "v54.1",
  vcpus: 2,
  bridge: "brmx",
  gatewayIPv4: "10.78.0.1",
  prefixLength: 22,
  nameservers: ["1.1.1.1", "9.9.9.9"],
  vmUser: "matrix-vm",
  vmGroup: "matrix-vm",
  execTimeoutMs: 60_000,
  chTimeoutMs: 30_000,
  restoreTimeoutMs: 10_000,
  stopGraceMs: 20_000,
  trimSettleMs: 5_000,
  maxInFlight: 4096,
};

export interface VmLifecycleDeps {
  store: VmStore;
  exec: Exec;
  // Returns a client for the VM's API socket; the lifecycle closes it after each operation.
  ch: (id: string) => ChClient;
  pool: { freeBytes(): Promise<number> };
  gatewayHealth: (ip: string, signal: AbortSignal) => Promise<boolean>;
  // Asks the guest agent to drop caches and compact before a snapshot (wired in H5).
  trim: (id: string, signal: AbortSignal) => Promise<void>;
  clock?: LifecycleClock;
  log?: (event: string, fields: Record<string, unknown>) => void;
  config?: Partial<LifecycleConfig>;
}

export type ResumeResult = "running" | "starting";

export interface VmLifecycle {
  create(spec: CreateVmSpec): Promise<VmRecord>;
  start(id: string): Promise<VmRecord>;
  suspend(id: string): Promise<VmRecord>;
  resume(id: string, budgetMs: number): Promise<ResumeResult>;
  stop(id: string): Promise<VmRecord>;
  destroy(id: string): Promise<void>;
  // Hotplugs or unplugs memory to targetMiB; refuses unless the VM is running.
  resize(id: string, targetMiB: number): Promise<void>;
  // Changes tier and memory ceiling; a raised ceiling takes effect at the next cold boot.
  setPolicy(id: string, policy: { tier: VmTier; maxMiB: number }): Promise<VmRecord>;
  // Resolves once every operation queued so far has settled.
  idle(): Promise<void>;
}

export type LifecycleErrorCode =
  | "invalid"
  | "not_found"
  | "conflict"
  | "busy"
  | "pool_full"
  | "no_capacity"
  | "snapshot_failed"
  | "failed";

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;

  constructor(code: LifecycleErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LifecycleError";
    this.code = code;
  }
}

const MiB = 1024 * 1024;
const MAX_USER_DATA_BYTES = 64 * 1024;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_MACHINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IP_BASE = (10 << 24) | (78 << 16); // 10.78.0.0
const IP_FIRST = IP_BASE + 10; // 10.78.0.10
const IP_LAST = IP_BASE + (3 << 8) + 250; // 10.78.3.250
const HEALTH_POLL_MS = 250;
const RESTORE_POLL_MS = 50;

const toIPv4 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
const fromIPv4 = (ip: string) => ip.split(".").reduce((acc, part) => acc * 256 + Number(part), 0);
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const macFor = (n: number) => `52:54:00:78:${hex2((n >>> 8) & 255)}:${hex2(n & 255)}`;

function validateSpec(spec: CreateVmSpec): void {
  const ok =
    SAFE_MACHINE_ID.test(spec.machineId) &&
    Number.isSafeInteger(spec.generation) &&
    spec.generation >= 0 &&
    SAFE_HANDLE.test(spec.handle) &&
    (spec.tier === "free" || spec.tier === "paid") &&
    Number.isSafeInteger(spec.bootMiB) &&
    spec.bootMiB >= 512 &&
    spec.bootMiB % 128 === 0 &&
    Number.isSafeInteger(spec.maxMiB) &&
    spec.maxMiB > spec.bootMiB &&
    spec.maxMiB % 128 === 0 &&
    Number.isSafeInteger(spec.diskGiB) &&
    spec.diskGiB > 0 &&
    typeof spec.userData === "string" &&
    Buffer.byteLength(spec.userData) <= MAX_USER_DATA_BYTES &&
    SAFE_VERSION.test(spec.goldenVersion);
  if (!ok) throw new LifecycleError("invalid", "invalid VM spec");
}

const errorFields = (error: unknown) =>
  error instanceof Error ? { error: error.name, message: error.message } : { error: String(error) };

export function createVmLifecycle(deps: VmLifecycleDeps): VmLifecycle {
  const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...deps.config };
  const { store, exec } = deps;
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const inflight = new Map<string, { kind: string; promise: Promise<unknown> }>();
  let allocation: Promise<unknown> = Promise.resolve();

  const vmUnit = (id: string) => `matrix-vm@${id}.service`;
  const restoreUnit = (id: string) => `matrix-vm-restore@${id}.service`;
  const lvName = (id: string) => `${cfg.volumeGroup}/mx-${id}`;
  const snapshotDir = (id: string) => join(cfg.snapshotsDir, id);
  const sh = (argv: readonly [string, ...string[]]) => run(exec, argv, AbortSignal.timeout(cfg.execTimeoutMs));
  const chSignal = () => AbortSignal.timeout(cfg.chTimeoutMs);

  function enqueue<T>(id: string, kind: string, operation: () => Promise<T>): Promise<T> {
    const tail = inflight.get(id);
    if (tail?.kind === kind) return tail.promise as Promise<T>;
    if (tail === undefined && inflight.size >= cfg.maxInFlight) {
      return Promise.reject(new LifecycleError("busy", "too many VM operations in flight"));
    }
    const previous = tail?.promise ?? Promise.resolve();
    const promise = previous.then(
      () => operation(),
      () => operation(),
    );
    const entry = { kind, promise };
    inflight.set(id, entry);
    const settle = () => {
      if (inflight.get(id) === entry) inflight.delete(id);
    };
    promise.then(settle, settle);
    return promise;
  }

  async function load(id: string): Promise<VmRecord> {
    const record = isVmId(id) ? await store.get(id) : null;
    if (record === null) throw new LifecycleError("not_found", "VM not found");
    return record;
  }

  async function save(record: VmRecord, patch: Partial<VmRecord>): Promise<VmRecord> {
    const next = { ...record, ...patch, updatedAt: new Date(clock.now()).toISOString() };
    await store.put(next);
    return next;
  }

  async function withCh<T>(id: string, use: (client: ChClient) => Promise<T>): Promise<T> {
    const client = deps.ch(id);
    try {
      return await use(client);
    } finally {
      await client.close();
    }
  }

  async function stopUnits(id: string): Promise<void> {
    await sh(["systemctl", "stop", vmUnit(id), restoreUnit(id)]);
  }

  async function dropSnapshot(id: string): Promise<void> {
    await rm(snapshotDir(id), { recursive: true, force: true });
    await rm(`${snapshotDir(id)}.new`, { recursive: true, force: true });
  }

  async function allocateAddress(): Promise<number> {
    const used = new Set((await store.list()).map((r) => fromIPv4(r.privateIPv4)));
    for (let n = IP_FIRST; n <= IP_LAST; n += 1) if (!used.has(n)) return n;
    throw new LifecycleError("no_capacity", "no private address left on this host");
  }

  function unitEnv(record: VmRecord, address: number): string {
    const id = record.id;
    const run = join(cfg.runDir, id);
    const values: Record<string, string | number> = {
      API_SOCKET: join(run, "ch.sock"),
      VSOCK_SOCKET: join(run, "vsock.sock"),
      VSOCK_CID: 3 + (address - IP_FIRST),
      KERNEL: cfg.kernelPath,
      INITRAMFS: cfg.initramfsPath,
      KERNEL_CMDLINE: cfg.kernelCmdline,
      VCPUS: cfg.vcpus,
      BOOT_MIB: record.bootMiB,
      HOTPLUG_MIB: record.maxMiB - record.bootMiB,
      DISK: `/dev/${lvName(id)}`,
      SEED: join(cfg.vmsDir, id, "seed.img"),
      TAP: `mxtap${address - IP_FIRST}`,
      MAC: record.mac,
      BRIDGE: cfg.bridge,
      SERIAL_PATH: join(cfg.serialLogDir, `${id}.serial`),
      SNAPSHOT_DIR: snapshotDir(id),
      VM_USER: cfg.vmUser,
    };
    return Object.entries(values)
      .map(([key, value]) => (typeof value === "string" && value.includes(" ") ? `${key}="${value}"` : `${key}=${value}`))
      .join("\n")
      .concat("\n");
  }

  async function writeSeed(record: VmRecord, userData: string): Promise<void> {
    const dir = join(cfg.vmsDir, record.id);
    const files = {
      userData: join(dir, "user-data"),
      metaData: join(dir, "meta-data"),
      network: join(dir, "network-config"),
    };
    const network = [
      "version: 2",
      "ethernets:",
      "  eth0:",
      "    match:",
      `      macaddress: "${record.mac}"`,
      "    set-name: eth0",
      `    addresses: [${record.privateIPv4}/${cfg.prefixLength}]`,
      "    routes:",
      "      - to: default",
      `        via: ${cfg.gatewayIPv4}`,
      "    nameservers:",
      `      addresses: [${cfg.nameservers.join(", ")}]`,
      "",
    ].join("\n");
    try {
      await writeFile(files.userData, userData, { flag: "wx", mode: 0o600 });
      await writeFile(files.metaData, `instance-id: ${record.id}\nlocal-hostname: ${record.handle}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await writeFile(files.network, network, { flag: "wx", mode: 0o600 });
      const seed = join(dir, "seed.img");
      await sh(["cloud-localds", "--network-config", files.network, seed, files.userData, files.metaData]);
      await sh(["chown", `${cfg.vmUser}:${cfg.vmUser}`, seed]);
      await sh(["chmod", "0600", seed]);
    } finally {
      await Promise.all(Object.values(files).map((path) => rm(path, { force: true })));
    }
  }

  async function create(spec: CreateVmSpec): Promise<VmRecord> {
    validateSpec(spec);
    // Allocation is serialized host-wide so two creates never share an address or a machine.
    const claim = allocation.then(async () => {
      let existing = (await store.list()).find((r) => r.machineId === spec.machineId);
      if (existing?.state === "failed" && existing.generation === spec.generation) {
        // A failed attempt is not a VM: clear it and create afresh.
        const failedId = existing.id;
        await enqueue(failedId, "destroy", () => destroy(failedId));
        existing = undefined;
      }
      if (existing !== undefined) {
        if (existing.generation === spec.generation) return { record: existing, fresh: false, address: 0 };
        throw new LifecycleError("conflict", "machine already has a VM with another generation");
      }
      const address = await allocateAddress();
      const record: VmRecord = {
        id: `vm_${randomBytes(12).toString("hex")}`,
        machineId: spec.machineId,
        generation: spec.generation,
        handle: spec.handle,
        tier: spec.tier,
        state: "creating",
        privateIPv4: toIPv4(address),
        mac: macFor(address),
        bootMiB: spec.bootMiB,
        maxMiB: spec.maxMiB,
        diskGiB: spec.diskGiB,
        chVersion: cfg.chVersion,
        snapshot: null,
        updatedAt: new Date(clock.now()).toISOString(),
      };
      await store.put(record);
      return { record, fresh: true, address };
    });
    // The caller receives claim's rejection; the chain only needs to keep moving.
    allocation = claim.then(
      () => undefined,
      (error: unknown) => error,
    );
    const { record, fresh, address } = await claim;
    if (!fresh) return record;

    return enqueue(record.id, "create", async () => {
      try {
        await sh([
          "lvcreate", "--snapshot", "--setactivationskip", "n", "--activate", "y",
          "--name", `mx-${record.id}`, `${cfg.volumeGroup}/golden-${spec.goldenVersion}`,
        ]);
        // The VMM (vmGroup) must traverse the directory to open seed.img; record.json stays 0600.
        const vmDir = join(cfg.vmsDir, record.id);
        await sh(["chgrp", cfg.vmGroup, vmDir]);
        await chmod(vmDir, 0o750);
        await writeSeed(record, spec.userData);
        await writeFileAtomic(join(cfg.vmsDir, record.id, "unit.env"), unitEnv(record, address), 0o644);
        await sh(["systemctl", "start", vmUnit(record.id)]);
        return await save(record, { state: "running" });
      } catch (error: unknown) {
        log("vm_create_failed", { id: record.id, ...errorFields(error) });
        await save(record, { state: "failed" });
        throw new LifecycleError("failed", "VM creation failed", { cause: error });
      }
    });
  }

  async function coldBoot(record: VmRecord): Promise<VmRecord> {
    await stopUnits(record.id);
    await dropSnapshot(record.id);
    await sh(["systemctl", "start", vmUnit(record.id)]);
    // The record carries the version of the VMM now running, which labels its next snapshot.
    return save(record, { state: "running", snapshot: null, chVersion: cfg.chVersion });
  }

  async function restore(record: VmRecord): Promise<void> {
    await sh(["systemctl", "start", restoreUnit(record.id)]);
    await withCh(record.id, async (client) => {
      const deadline = clock.now() + cfg.restoreTimeoutMs;
      for (;;) {
        try {
          const { state } = await client.info(chSignal());
          if (state === "Running") return;
          if (state === "Paused") {
            await client.resume(chSignal());
            return;
          }
        } catch (error: unknown) {
          if (!(error instanceof ChError && error.code === "unreachable")) throw error;
        }
        if (clock.now() >= deadline) throw new LifecycleError("failed", "restored VM did not come up");
        await clock.sleep(RESTORE_POLL_MS);
      }
    });
  }

  // Brings a stopped or suspended VM to running; does not wait for the gateway.
  async function wake(record: VmRecord): Promise<VmRecord> {
    if (record.state === "running") return record;
    if (record.state === "creating") throw new LifecycleError("conflict", "VM is still being created");
    const snapshot = record.snapshot;
    if (record.state !== "suspended" || snapshot === null || snapshot.chVersion !== cfg.chVersion) {
      return coldBoot(record);
    }
    const resuming = await save(record, { state: "resuming" });
    try {
      await restore(resuming);
      return await save(resuming, { state: "running", chVersion: cfg.chVersion });
    } catch (error: unknown) {
      log("vm_restore_failed", { id: record.id, ...errorFields(error) });
      try {
        return await coldBoot(resuming);
      } catch (bootError: unknown) {
        log("vm_cold_boot_failed", { id: record.id, ...errorFields(bootError) });
        await save(resuming, { state: "failed" });
        throw new LifecycleError("failed", "VM could not be resumed", { cause: bootError });
      }
    }
  }

  async function waitHealthy(record: VmRecord, deadline: number): Promise<ResumeResult> {
    for (;;) {
      const remaining = deadline - clock.now();
      let healthy = false;
      try {
        healthy = await deps.gatewayHealth(record.privateIPv4, AbortSignal.timeout(Math.min(Math.max(remaining, 100), 2000)));
      } catch (error: unknown) {
        log("vm_health_probe_failed", { id: record.id, ...errorFields(error) });
      }
      if (healthy) return "running";
      if (clock.now() >= deadline) return "starting";
      await clock.sleep(Math.min(HEALTH_POLL_MS, Math.max(deadline - clock.now(), 1)));
    }
  }

  async function suspend(record: VmRecord): Promise<VmRecord> {
    if (record.state === "suspended") return record;
    if (record.state !== "running") throw new LifecycleError("conflict", `VM is ${record.state}`);
    if ((await deps.pool.freeBytes()) < 2 * record.bootMiB * MiB) {
      log("vm_suspend_pool_full", { id: record.id });
      throw new LifecycleError("pool_full", "snapshot pool is full");
    }
    const suspending = await save(record, { state: "suspending" });
    try {
      await deps.trim(record.id, AbortSignal.timeout(cfg.chTimeoutMs));
    } catch (error: unknown) {
      log("vm_trim_failed", { id: record.id, ...errorFields(error) });
    }
    await clock.sleep(cfg.trimSettleMs);

    // An ondemand-restored VMM still maps the current snapshot, so write beside it.
    const finalDir = snapshotDir(record.id);
    const newDir = `${finalDir}.new`;
    let paused = false;
    try {
      await rm(newDir, { recursive: true, force: true });
      await mkdir(newDir, { mode: 0o700 });
      await sh(["chown", `${cfg.vmUser}:${cfg.vmUser}`, newDir]);
      await withCh(record.id, async (client) => {
        await client.pause(chSignal());
        paused = true;
        await client.snapshot(newDir, chSignal());
      });
      await stopUnits(record.id);
    } catch (error: unknown) {
      log("vm_snapshot_failed", { id: record.id, alert: true, ...errorFields(error) });
      let state: "running" | "failed" = "running";
      if (paused) {
        try {
          await withCh(record.id, (client) => client.resume(chSignal()));
        } catch (resumeError: unknown) {
          // The VM may be left paused: "failed" makes the next wake cold-boot it.
          state = "failed";
          log("vm_resume_after_snapshot_failure_failed", { id: record.id, alert: true, ...errorFields(resumeError) });
        }
      }
      await rm(newDir, { recursive: true, force: true });
      await save(suspending, { state });
      throw new LifecycleError("snapshot_failed", "VM snapshot failed", { cause: error });
    }

    // The VMM has exited: the old snapshot is no longer mapped and can be replaced.
    try {
      await rm(finalDir, { recursive: true, force: true });
      await rename(newDir, finalDir);
    } catch (error: unknown) {
      log("vm_snapshot_swap_failed", { id: record.id, alert: true, ...errorFields(error) });
      await save(suspending, { state: "failed", snapshot: null });
      throw new LifecycleError("failed", "snapshot could not be stored", { cause: error });
    }
    try {
      await sh(["fallocate", "--dig-holes", join(finalDir, "memory-ranges")]);
    } catch (error: unknown) {
      log("vm_snapshot_sparsify_failed", { id: record.id, ...errorFields(error) });
    }
    return save(suspending, {
      state: "suspended",
      snapshot: { dir: finalDir, takenAt: new Date(clock.now()).toISOString(), chVersion: record.chVersion },
    });
  }

  async function stop(record: VmRecord): Promise<VmRecord> {
    if (record.state === "running") {
      try {
        await withCh(record.id, async (client) => {
          await client.powerButton(chSignal());
          const deadline = clock.now() + cfg.stopGraceMs;
          while (clock.now() < deadline) {
            if ((await client.info(chSignal())).state === "Shutdown") return;
            await clock.sleep(HEALTH_POLL_MS);
          }
        });
      } catch (error: unknown) {
        if (!(error instanceof ChError && error.code === "unreachable")) {
          log("vm_power_button_failed", { id: record.id, ...errorFields(error) });
        }
      }
    }
    await stopUnits(record.id);
    // A snapshot is only valid with the disk it was taken against; a stop ends that.
    await dropSnapshot(record.id);
    return save(record, { state: "stopped", snapshot: null });
  }

  async function destroy(id: string): Promise<void> {
    const record = isVmId(id) ? await store.get(id) : null;
    if (record === null) return;
    await stopUnits(id);
    await exec(["systemctl", "reset-failed", vmUnit(id), restoreUnit(id)], {
      signal: AbortSignal.timeout(cfg.execTimeoutMs),
    });
    const lv = await exec(["lvs", lvName(id)], { signal: AbortSignal.timeout(cfg.execTimeoutMs) });
    if (lv.code === 0) await sh(["lvremove", "--yes", lvName(id)]);
    await dropSnapshot(id);
    await rm(join(cfg.serialLogDir, `${id}.serial`), { force: true });
    await store.remove(id);
  }

  async function resize(id: string, targetMiB: number): Promise<void> {
    const record = await load(id);
    if (!Number.isSafeInteger(targetMiB) || targetMiB < record.bootMiB || targetMiB > record.maxMiB) {
      throw new LifecycleError("invalid", "memory target out of range");
    }
    if (record.state !== "running") throw new LifecycleError("conflict", `VM is ${record.state}`);
    await withCh(id, (client) => client.resizeMemory(targetMiB * MiB, chSignal()));
  }

  async function setPolicy(id: string, policy: { tier: VmTier; maxMiB: number }): Promise<VmRecord> {
    const record = await load(id);
    const { tier, maxMiB } = policy;
    const valid =
      (tier === "free" || tier === "paid") &&
      Number.isSafeInteger(maxMiB) &&
      maxMiB > record.bootMiB &&
      maxMiB % 128 === 0;
    if (!valid) throw new LifecycleError("invalid", "invalid VM policy");
    if (record.state === "creating") throw new LifecycleError("conflict", "VM is still being created");
    const envPath = join(cfg.vmsDir, id, "unit.env");
    const env = await readFile(envPath, "utf8");
    await writeFileAtomic(envPath, env.replace(/^HOTPLUG_MIB=\d+$/m, `HOTPLUG_MIB=${maxMiB - record.bootMiB}`), 0o644);
    return save(record, { tier, maxMiB });
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0) {
      await Promise.allSettled([...inflight.values()].map((entry) => entry.promise));
    }
    await allocation;
  }

  return {
    create,
    resize: (id, targetMiB) => enqueue(id, `resize:${targetMiB}`, () => resize(id, targetMiB)),
    setPolicy: (id, policy) =>
      enqueue(id, `policy:${policy.tier}:${policy.maxMiB}`, () => setPolicy(id, policy)),
    idle,
    start: (id) => enqueue(id, "start", async () => wake(await load(id))),
    suspend: (id) => enqueue(id, "suspend", async () => suspend(await load(id))),
    async resume(id, budgetMs) {
      const deadline = clock.now() + Math.max(0, budgetMs);
      return enqueue(id, "resume", async () => waitHealthy(await wake(await load(id)), deadline));
    },
    stop: (id) => enqueue(id, "stop", async () => stop(await load(id))),
    destroy: (id) => enqueue(id, "destroy", () => destroy(id)),
  };
}
