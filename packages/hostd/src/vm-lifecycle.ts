import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChError, type ChClient } from "./ch-client.js";
import { run, type Exec } from "./exec.js";
import { fitsVmMemory } from "./memory-admission.js";
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
  // The LVM thin pool in volumeGroup that holds every VM disk.
  thinPool: string;
  // Create refuses (capacity) while the thin pool's data or metadata use is
  // above these percentages: a full thin pool hangs every guest writing to it.
  poolMaxDataPercent: number;
  poolMaxMetadataPercent: number;
  // Bound on one thin pool read: create holds the host-wide allocation chain
  // while it runs, so an LVM lock must not stall every create for execTimeoutMs.
  poolQueryTimeoutMs: number;
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
  thinPool: "pool",
  poolMaxDataPercent: 85,
  poolMaxMetadataPercent: 80,
  poolQueryTimeoutMs: 5_000,
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
  // Host-wide ceiling for VM RAM including per-VMM overhead. The process entry
  // always wires the production budget.
  memoryBudgetMiB?: () => number;
  gatewayHealth: (ip: string, signal: AbortSignal) => Promise<boolean>;
  // Asks the guest agent to drop caches and compact before a snapshot (wired in H5).
  trim: (id: string, signal: AbortSignal) => Promise<void>;
  clock?: LifecycleClock;
  log?: (event: string, fields: Record<string, unknown>) => void;
  config?: Partial<LifecycleConfig>;
}

export type ResumeResult = "running" | "starting";

// Fences an operation on the VM's generation: checked inside the per-VM queue,
// when the operation runs, so no other operation can slip between the check
// and the act. A mismatch rejects with `conflict` without touching the VM.
export interface GenerationFence {
  expectedGeneration?: number;
}

export interface SuspendOptions extends GenerationFence {
  // Called once the queued suspend has passed its checks and starts acting.
  onAccepted?: () => void;
}

export interface ThinPoolUsage {
  dataPercent: number;
  metadataPercent: number;
}

export interface AutomaticResize extends Pick<VmRecord, "tier" | "maxMiB"> {
  action: "grow" | "shrink";
}

export interface VmLifecycle {
  create(spec: CreateVmSpec): Promise<VmRecord>;
  // The thin pool's data and metadata use; rejects with capacity when unreadable
  // or when it takes longer than poolQueryTimeoutMs or the caller's signal allows.
  thinPoolUsage(signal?: AbortSignal): Promise<ThinPoolUsage>;
  start(id: string): Promise<VmRecord>;
  suspend(id: string, options?: SuspendOptions): Promise<VmRecord>;
  resume(id: string, budgetMs: number, options?: GenerationFence): Promise<ResumeResult>;
  stop(id: string): Promise<VmRecord>;
  destroy(id: string): Promise<void>;
  // Hotplugs or unplugs memory to targetMiB; refuses unless the VM is running.
  resize(id: string, targetMiB: number, automatic?: AutomaticResize): Promise<void>;
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
  | "capacity"
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
const GiB = 1024 * MiB;
// Free-tier limits, enforced here as defense in depth (the platform enforces them too).
export const FREE_BOOT_MIB = 2048;
export const FREE_MAX_MIB = 8192;
export const FREE_DISK_GIB = 40;
// Host maximum for any VM.
export const HOST_MAX_MIB = 131_072;
const maxMiBFor = (tier: VmTier) => (tier === "free" ? FREE_MAX_MIB : HOST_MAX_MIB);
const MAX_USER_DATA_BYTES = 64 * 1024;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SAFE_MACHINE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const IP_BASE = (10 << 24) | (78 << 16); // 10.78.0.0
const IP_FIRST = IP_BASE + 10; // 10.78.0.10
const IP_LAST = IP_BASE + (3 << 8) + 250; // 10.78.3.250
const HEALTH_POLL_MS = 250;
// What lvs prints (exit code 5) for an LV that does not exist.
const LV_MISSING = /Failed to find logical volume/;
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
    SAFE_VERSION.test(spec.goldenVersion) &&
    spec.maxMiB <= maxMiBFor(spec.tier) &&
    (spec.tier !== "free" || (spec.bootMiB === FREE_BOOT_MIB && spec.diskGiB <= FREE_DISK_GIB));
  if (!ok) throw new LifecycleError("invalid", "invalid VM spec");
}

const errorFields = (error: unknown) =>
  error instanceof Error ? { error: error.name, message: error.message } : { error: String(error) };

export function createVmLifecycle(deps: VmLifecycleDeps): VmLifecycle {
  const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, ...deps.config };
  const { store, exec } = deps;
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const inflight = new Map<string, { kind: string; promise: Promise<unknown>; accepted: Promise<void> }>();
  let allocation: Promise<unknown> = Promise.resolve();
  // The memory lock never waits on a VM's operation queue. Create can hold
  // the address lock while tearing down a previous failed VM.
  let memoryAllocation: Promise<unknown> = Promise.resolve();
  let snapshotAllocation: Promise<unknown> = Promise.resolve();
  let reservedSnapshotBytes = 0;
  // Every create() call from entry until it settles, so idle() also waits for
  // a create that is still allocating its record. Capped by maxInFlight.
  const creates = new Set<Promise<unknown>>();

  const vmUnit = (id: string) => `matrix-vm@${id}.service`;
  const restoreUnit = (id: string) => `matrix-vm-restore@${id}.service`;
  const lvName = (id: string) => `${cfg.volumeGroup}/mx-${id}`;
  const goldenName = (version: string) => `${cfg.volumeGroup}/golden-${version}`;
  const snapshotDir = (id: string) => join(cfg.snapshotsDir, id);
  const sh = (argv: readonly [string, ...string[]]) => run(exec, argv, AbortSignal.timeout(cfg.execTimeoutMs));
  const chSignal = () => AbortSignal.timeout(cfg.chTimeoutMs);

  // `accept` marks the point an operation has passed its checks; it is implied
  // when the operation resolves. A caller joining the tail is notified through
  // the same entry, since the kind (which includes any fence) is identical.
  function enqueue<T>(
    id: string,
    kind: string,
    operation: (accept: () => void) => Promise<T>,
    onAccepted?: () => void,
  ): Promise<T> {
    const tail = inflight.get(id);
    if (tail?.kind === kind) {
      if (onAccepted) void tail.accepted.then(onAccepted);
      return tail.promise as Promise<T>;
    }
    if (tail === undefined && inflight.size >= cfg.maxInFlight) {
      return Promise.reject(new LifecycleError("busy", "too many VM operations in flight"));
    }
    let accept!: () => void;
    const accepted = new Promise<void>((resolve) => {
      accept = resolve;
    });
    if (onAccepted) void accepted.then(onAccepted);
    const previous = tail?.promise ?? Promise.resolve();
    const promise = previous.then(
      () => operation(accept),
      () => operation(accept),
    );
    const entry = { kind, promise, accepted };
    inflight.set(id, entry);
    const settle = () => {
      if (inflight.get(id) === entry) inflight.delete(id);
    };
    promise.then(() => {
      accept();
      settle();
    }, settle);
    return promise;
  }

  function allocateMemory<T>(operation: () => Promise<T>): Promise<T> {
    const claim = memoryAllocation.then(operation);
    memoryAllocation = claim.then(() => undefined, (error: unknown) => error);
    return claim;
  }

  function checkMemory(
    records: readonly VmRecord[],
    vmId: string | undefined,
    requestedMiB: number,
    refusal: "capacity" | "busy",
  ): void {
    if (deps.memoryBudgetMiB && !fitsVmMemory(deps.memoryBudgetMiB(), records, vmId, requestedMiB)) {
      throw new LifecycleError(refusal, "host VM memory is fully reserved");
    }
  }

  function reserveWakeMemory(record: VmRecord, memoryReservationMiB: number): Promise<VmRecord> {
    return allocateMemory(async () => {
      checkMemory(await store.list(), record.id, memoryReservationMiB, "busy");
      // Publish before starting systemd so simultaneous wakes see the claim.
      return save(record, { state: "resuming", memoryReservationMiB });
    });
  }

  const fencedKind = (kind: string, fence: GenerationFence) =>
    fence.expectedGeneration === undefined ? kind : `${kind}@${fence.expectedGeneration}`;

  async function loadFenced(id: string, fence: GenerationFence): Promise<VmRecord> {
    const record = await load(id);
    if (fence.expectedGeneration !== undefined && record.generation !== fence.expectedGeneration) {
      throw new LifecycleError("conflict", "VM generation does not match");
    }
    return record;
  }

  async function load(id: string): Promise<VmRecord> {
    const record = isVmId(id) ? await store.get(id) : null;
    if (record === null) throw new LifecycleError("not_found", "VM not found");
    return record;
  }

  async function save(record: VmRecord, patch: Partial<VmRecord>): Promise<VmRecord> {
    const next: VmRecord = { ...record, ...patch, updatedAt: new Date(clock.now()).toISOString() };
    if (next.state !== "failed") delete next.failedDuring;
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
      PRIVATE_IPV4: record.privateIPv4,
      BRIDGE: cfg.bridge,
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

  // The golden LV's size in bytes. A clone starts at this size; a VM disk can
  // grow past it (lvextend, then cloud-init growpart in the guest) but never shrink.
  async function goldenBytes(version: string): Promise<number> {
    const result = await exec(
      ["lvs", "--noheadings", "--nosuffix", "--units", "b", "-o", "lv_size", goldenName(version)],
      { signal: AbortSignal.timeout(cfg.execTimeoutMs) },
    );
    if (result.code === 5) throw new LifecycleError("invalid", "golden image not found");
    const bytes = Number(result.stdout.trim());
    if (result.code !== 0 || !Number.isSafeInteger(bytes) || bytes <= 0) {
      log("vm_golden_size_unreadable", { version, exitCode: result.code });
      throw new LifecycleError("failed", "golden image size unreadable");
    }
    return bytes;
  }

  async function thinPoolUsage(signal?: AbortSignal): Promise<ThinPoolUsage> {
    const pool = `${cfg.volumeGroup}/${cfg.thinPool}`;
    const timeout = AbortSignal.timeout(cfg.poolQueryTimeoutMs);
    let result: { code: number; stdout: string };
    try {
      // Never pass --readonly: it skips the device-mapper status query, so on
      // LVM 2.03.16 data_percent and metadata_percent print blank and every
      // create would fail closed. A plain lvs answers in ~40 ms; the short
      // poolQueryTimeoutMs bounds it if it waits on the LVM lock.
      result = await exec(
        ["lvs", "--noheadings", "--nosuffix", "-o", "data_percent,metadata_percent", pool],
        { signal: signal ? AbortSignal.any([timeout, signal]) : timeout },
      );
    } catch (error: unknown) {
      log("vm_thin_pool_unreadable", { pool, ...errorFields(error) });
      throw new LifecycleError("capacity", "thin pool usage unreadable", { cause: error });
    }
    // Some locales print a decimal comma; the fields are whitespace separated.
    const fields = result.stdout.trim().split(/\s+/).map((f) => Number(f.replace(",", ".")));
    const valid = (n: number | undefined): n is number => n !== undefined && Number.isFinite(n) && n >= 0 && n <= 100;
    const [dataPercent, metadataPercent] = fields;
    if (result.code !== 0 || fields.length !== 2 || !valid(dataPercent) || !valid(metadataPercent)) {
      log("vm_thin_pool_unreadable", { pool, exitCode: result.code });
      throw new LifecycleError("capacity", "thin pool usage unreadable");
    }
    return { dataPercent, metadataPercent };
  }

  function create(spec: CreateVmSpec): Promise<VmRecord> {
    if (creates.size >= cfg.maxInFlight) {
      return Promise.reject(new LifecycleError("busy", "too many VM operations in flight"));
    }
    const pending = createVm(spec);
    creates.add(pending);
    const forget = () => {
      creates.delete(pending);
    };
    pending.then(forget, forget);
    return pending;
  }

  async function createVm(spec: CreateVmSpec): Promise<VmRecord> {
    validateSpec(spec);
    // Allocation is serialized host-wide so two creates never share an address or a machine.
    const claim = allocation.then(async () => {
      const records = await store.list();
      let existing = records.find((r) => r.machineId === spec.machineId);
      if (existing?.state === "failed" && existing.failedDuring === "create" && existing.generation === spec.generation) {
        // A create that never finished holds no owner data: clear it and create afresh.
        const failedId = existing.id;
        await enqueue(failedId, "destroy", () => destroy(failedId));
        existing = undefined;
      }
      if (existing !== undefined) {
        if (existing.state === "failed") {
          // A VM that failed after creation has a real disk: never reprovision it here.
          throw new LifecycleError("conflict", "machine has a failed VM that must be recovered");
        }
        if (existing.generation === spec.generation) return { record: existing, fresh: false, address: 0, extend: false };
        throw new LifecycleError("conflict", "machine already has a VM with another generation");
      }
      const golden = await goldenBytes(spec.goldenVersion);
      if (spec.diskGiB * GiB < golden) {
        throw new LifecycleError("invalid", "requested disk is smaller than the golden image");
      }
      // Fail closed: a create on a nearly full (or unreadable) thin pool goes elsewhere.
      const usage = await thinPoolUsage();
      if (usage.dataPercent > cfg.poolMaxDataPercent || usage.metadataPercent > cfg.poolMaxMetadataPercent) {
        log("vm_thin_pool_full", {
          ...usage,
          maxDataPercent: cfg.poolMaxDataPercent,
          maxMetadataPercent: cfg.poolMaxMetadataPercent,
        });
        throw new LifecycleError("capacity", "thin pool is too full for a new VM");
      }
      // Admit before saving: a create refused as busy must not leave a record.
      if (inflight.size >= cfg.maxInFlight) {
        throw new LifecycleError("busy", "too many VM operations in flight");
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
        memoryReservationMiB: spec.maxMiB,
        diskGiB: spec.diskGiB,
        chVersion: cfg.chVersion,
        snapshot: null,
        updatedAt: new Date(clock.now()).toISOString(),
      };
      await allocateMemory(async () => {
        if (deps.memoryBudgetMiB) checkMemory(await store.list(), undefined, spec.maxMiB, "capacity");
        await store.put(record);
      });
      // Another machine's VM may still hold this handle: a re-provision creates
      // the new VM before the platform tears the old one down. Ingress routes
      // the handle to the better VM, so this is a warning, not a refusal.
      const others = records.filter((r) => r.handle === spec.handle && r.machineId !== spec.machineId).map((r) => r.id);
      if (others.length > 0) log("vm_create_handle_shared", { id: record.id, machineId: spec.machineId, others });
      return { record, fresh: true, address, extend: spec.diskGiB * GiB > golden };
    });
    // The caller receives claim's rejection; the chain only needs to keep moving.
    allocation = claim.then(() => undefined, (error: unknown) => error);
    const { record, fresh, address, extend } = await claim;
    if (!fresh) return record;

    let started = false;
    const work = enqueue(record.id, "create", async () => {
      started = true;
      try {
        await sh([
          "lvcreate", "--snapshot", "--setactivationskip", "n", "--activate", "y",
          "--name", `mx-${record.id}`, goldenName(spec.goldenVersion),
        ]);
        // The clone has the golden's size; grow it to the requested disk before
        // the first boot, where cloud-init growpart/resizefs grow the root fs.
        if (extend) await sh(["lvextend", "--size", `${spec.diskGiB}G`, lvName(record.id)]);
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
        await save(record, { state: "failed", failedDuring: "create" });
        throw new LifecycleError("failed", "VM creation failed", { cause: error });
      }
    });
    try {
      return await work;
    } catch (error: unknown) {
      // Refused at the queue after the record was saved: drop the record (no
      // disk exists yet) so a retry creates afresh instead of finding it stuck.
      if (!started && error instanceof LifecycleError && error.code === "busy") {
        await store.remove(record.id);
      }
      throw error;
    }
  }

  async function writeUnitRuntime(record: VmRecord, maxMiB: number): Promise<void> {
    const envPath = join(cfg.vmsDir, record.id, "unit.env");
    const env = await readFile(envPath, "utf8");
    const memory = env.replace(/^HOTPLUG_MIB=\d+$/m, `HOTPLUG_MIB=${maxMiB - record.bootMiB}`);
    const updated = /^PRIVATE_IPV4=/m.test(memory) ? memory : `${memory}PRIVATE_IPV4=${record.privateIPv4}\n`;
    if (updated !== env) await writeFileAtomic(envPath, updated, 0o644);
  }

  async function coldBoot(record: VmRecord): Promise<VmRecord> {
    await stopUnits(record.id);
    await writeUnitRuntime(record, record.maxMiB);
    await dropSnapshot(record.id);
    await sh(["systemctl", "start", vmUnit(record.id)]);
    // The record carries the version of the VMM now running, which labels its next snapshot.
    return save(record, {
      state: "running", snapshot: null, chVersion: cfg.chVersion, memoryReservationMiB: record.maxMiB,
    });
  }

  async function restore(record: VmRecord): Promise<void> {
    await writeUnitRuntime(record, record.maxMiB);
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

  async function runningVmNeedsBoot(id: string): Promise<boolean> {
    let state: Awaited<ReturnType<ChClient["info"]>>["state"];
    try {
      state = (await withCh(id, (client) => client.info(AbortSignal.timeout(2_000)))).state;
    } catch (error: unknown) {
      log("vm_wake_info_failed", { id, ...errorFields(error) });
      // A booting VMM may not have opened its socket yet. Only confirmed
      // inactive units authorize a new cold boot.
      const units = await exec(["systemctl", "is-active", vmUnit(id), restoreUnit(id)], {
        signal: AbortSignal.timeout(2_000),
      });
      if (units.code === 0 || /^(activating|reloading|deactivating)$/m.test(units.stdout)) return false;
      if (units.code !== 3 && units.code !== 4) {
        throw new LifecycleError("failed", "could not determine VM liveness", { cause: error });
      }
      return true;
    }
    if (state === "Paused") await withCh(id, (client) => client.resume(chSignal()));
    return state === "Shutdown";
  }

  // Brings a stopped or suspended VM to running; does not wait for the gateway.
  async function wake(record: VmRecord): Promise<VmRecord> {
    if (record.state === "running" && !(await runningVmNeedsBoot(record.id))) return record;
    if (record.state === "creating") throw new LifecycleError("conflict", "VM is still being created");
    const snapshot = record.snapshot;
    const snapshotMemoryMiB = record.memoryReservationMiB;
    // Older snapshots have neither a known memory ceiling nor a bounded
    // console. Cold boot those disks with the current unit policy.
    const canRestore = record.state === "suspended" && snapshot !== null &&
      snapshot.chVersion === cfg.chVersion && typeof snapshotMemoryMiB === "number";
    const reservation = canRestore ? Math.max(record.maxMiB, snapshotMemoryMiB) : record.maxMiB;
    const resuming = await reserveWakeMemory(record, reservation);
    if (!canRestore) {
      try {
        return await coldBoot(resuming);
      } catch (error: unknown) {
        await save(resuming, { state: "failed" });
        throw error;
      }
    }
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

  async function waitHealthy(record: VmRecord, deadline: number, signal: AbortSignal): Promise<ResumeResult> {
    while (!signal.aborted) {
      const remaining = deadline - clock.now();
      if (remaining <= 0) break;
      let healthy = false;
      try {
        healthy = await deps.gatewayHealth(record.privateIPv4, AbortSignal.any([signal, AbortSignal.timeout(Math.min(remaining, 2000))]));
      } catch (error: unknown) {
        if (signal.aborted) break;
        log("vm_health_probe_failed", { id: record.id, ...errorFields(error) });
      }
      if (healthy) return "running";
      const sleepMs = Math.min(HEALTH_POLL_MS, deadline - clock.now());
      if (sleepMs <= 0) break;
      await clock.sleep(sleepMs);
    }
    return "starting";
  }

  async function suspend(record: VmRecord): Promise<VmRecord> {
    if (record.state === "suspended") return record;
    if (record.state !== "running") throw new LifecycleError("conflict", `VM is ${record.state}`);
    // virtio-mem pages that are plugged now can be written into the snapshot.
    // Keep the existing 2x safety margin and account for other writers until
    // their snapshot is published or cleaned up.
    let memoryActualBytes = Math.max(record.maxMiB, record.memoryReservationMiB ?? 0) * MiB;
    try {
      ({ memoryActualBytes } = await withCh(record.id, (client) => client.info(chSignal())));
    } catch (error: unknown) {
      // A failed probe must never turn a grown guest back into a boot-sized estimate.
      log("vm_snapshot_size_probe_failed", { id: record.id, ...errorFields(error) });
    }
    const bytes = 2 * Math.max(record.bootMiB * MiB, memoryActualBytes);
    const claim = snapshotAllocation.then(async () => {
      if ((await deps.pool.freeBytes()) - reservedSnapshotBytes < bytes) {
        log("vm_suspend_pool_full", { id: record.id });
        throw new LifecycleError("pool_full", "snapshot pool is full");
      }
      reservedSnapshotBytes += bytes;
    });
    snapshotAllocation = claim.then(() => undefined, (error: unknown) => error);
    await claim;
    try {
      return await snapshotVm(record);
    } finally {
      reservedSnapshotBytes -= bytes;
    }
  }

  async function snapshotVm(record: VmRecord): Promise<VmRecord> {
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
    // Set before the request: a pause can take effect even if its reply is lost.
    let pauseSent = false;
    try {
      await rm(newDir, { recursive: true, force: true });
      await mkdir(newDir, { mode: 0o700 });
      await sh(["chown", `${cfg.vmUser}:${cfg.vmUser}`, newDir]);
      await withCh(record.id, async (client) => {
        pauseSent = true;
        await client.pause(chSignal());
        await client.snapshot(newDir, chSignal());
      });
      await stopUnits(record.id);
    } catch (error: unknown) {
      log("vm_snapshot_failed", { id: record.id, alert: true, ...errorFields(error) });
      let state: "running" | "failed" = "running";
      if (pauseSent) {
        try {
          // Ask rather than assume: resume a paused VM, accept a running one.
          await withCh(record.id, async (client) => {
            const { state: vmState } = await client.info(chSignal());
            if (vmState === "Paused") await client.resume(chSignal());
            else if (vmState !== "Running") throw new LifecycleError("failed", `VM is ${vmState} after a failed snapshot`);
          });
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
    return save(record, { state: "stopped", snapshot: null, memoryReservationMiB: undefined });
  }

  async function destroy(id: string): Promise<void> {
    const record = isVmId(id) ? await store.get(id) : null;
    if (record === null) return;
    await stopUnits(id);
    await exec(["systemctl", "reset-failed", vmUnit(id), restoreUnit(id)], {
      signal: AbortSignal.timeout(cfg.execTimeoutMs),
    });
    // Only "no such LV" proves the disk is gone; any other lvs failure (a lock,
    // unreadable metadata) keeps the record so a retry can still find the disk.
    const lv = await exec(["lvs", lvName(id)], { signal: AbortSignal.timeout(cfg.execTimeoutMs) });
    if (lv.code === 0) await sh(["lvremove", "--yes", lvName(id)]);
    else if (!LV_MISSING.test(lv.stderr)) throw new LifecycleError("failed", "could not tell whether the VM disk exists");
    await dropSnapshot(id);
    await rm(join(cfg.serialLogDir, `${id}.serial`), { force: true });
    await store.remove(id);
  }

  async function resize(id: string, targetMiB: number, automatic?: AutomaticResize): Promise<void> {
    const record = await load(id);
    if (!Number.isSafeInteger(targetMiB) || targetMiB < record.bootMiB) {
      throw new LifecycleError("invalid", "memory target out of range");
    }
    if (record.state !== "running") throw new LifecycleError("conflict", `VM is ${record.state}`);
    if (automatic && (record.tier !== automatic.tier || record.maxMiB !== automatic.maxMiB ||
      (record.tier === "paid" && automatic.action === "shrink"))) {
      throw new LifecycleError("conflict", "VM memory policy changed");
    }
    await withCh(id, async (client) => {
      // Above the ceiling only as a downward step: a lowered ceiling may sit
      // below what the guest still holds while it gives memory back.
      if (targetMiB > record.maxMiB || (automatic && record.tier === "paid")) {
        const actualMiB = Math.floor((await client.info(chSignal())).memoryActualBytes / MiB);
        if (automatic && record.tier === "paid" && targetMiB <= actualMiB) {
          throw new LifecycleError("conflict", "paid VM memory already meets the target");
        }
        if (targetMiB > record.maxMiB && targetMiB >= actualMiB) throw new LifecycleError("invalid", "memory target out of range");
      }
      await client.resizeMemory(targetMiB * MiB, chSignal());
    });
  }

  async function setPolicy(id: string, policy: { tier: VmTier; maxMiB: number }): Promise<VmRecord> {
    const record = await load(id);
    const { tier, maxMiB } = policy;
    const valid =
      (tier === "free" || tier === "paid") &&
      Number.isSafeInteger(maxMiB) &&
      maxMiB > record.bootMiB &&
      maxMiB % 128 === 0 &&
      maxMiB <= maxMiBFor(tier);
    if (!valid) throw new LifecycleError("invalid", "invalid VM policy");
    if (record.state === "creating") throw new LifecycleError("conflict", "VM is still being created");
    // A lowered ceiling below the running guest's memory: shrink first, and keep
    // the old ceiling if the shrink is refused.
    if (record.state === "running" && maxMiB < record.maxMiB) {
      await withCh(id, async (client) => {
        const actualMiB = Math.floor((await client.info(chSignal())).memoryActualBytes / MiB);
        if (actualMiB > maxMiB) await client.resizeMemory(maxMiB * MiB, chSignal());
      });
    }
    return allocateMemory(async () => {
      const holdsMemory = record.state !== "suspended" &&
        (record.state !== "stopped" || typeof record.memoryReservationMiB === "number") &&
        record.memoryReservationMiB !== null;
      const previousReserve = record.memoryReservationMiB ?? record.maxMiB;
      const reserved = holdsMemory ? Math.max(previousReserve, maxMiB) : record.memoryReservationMiB;
      if (holdsMemory && maxMiB > previousReserve) {
        checkMemory(await store.list(), id, maxMiB, "busy");
      }
      await writeUnitRuntime(record, maxMiB);
      return save(record, { tier, maxMiB, memoryReservationMiB: reserved });
    });
  }

  async function idle(): Promise<void> {
    while (inflight.size > 0 || creates.size > 0) {
      await Promise.allSettled([...creates, ...[...inflight.values()].map((entry) => entry.promise)]);
    }
    await allocation;
  }

  return {
    create,
    thinPoolUsage,
    resize: (id, targetMiB, automatic) => enqueue(id,
      automatic ? `auto-resize:${targetMiB}:${automatic.tier}:${automatic.maxMiB}:${automatic.action}` : `resize:${targetMiB}`,
      () => resize(id, targetMiB, automatic)),
    setPolicy: (id, policy) =>
      enqueue(id, `policy:${policy.tier}:${policy.maxMiB}`, () => setPolicy(id, policy)),
    idle,
    start: (id) => enqueue(id, "start", async () => wake(await load(id))),
    suspend: (id, options = {}) =>
      enqueue(
        id,
        fencedKind("suspend", options),
        async (accept) => {
          const record = await loadFenced(id, options);
          accept();
          return suspend(record);
        },
        options.onAccepted,
      ),
    async resume(id, budgetMs, fence = {}) {
      // Concurrent callers share the wake. The caller's deadline also covers
      // queueing and systemd, and only cancels its gateway probes.
      const budget = Math.max(0, budgetMs);
      const deadline = clock.now() + budget;
      const probes = new AbortController();
      // Check the caller's record without waiting behind a suspend. The
      // queued operation still rechecks it before doing any work.
      let recordVerified = false;
      const verification = loadFenced(id, fence).then(() => { recordVerified = true; });
      const waking = enqueue(id, fencedKind("resume", fence), async () => {
        await verification;
        return wake(await loadFenced(id, fence));
      });
      const response = Promise.all([verification, waking]).then(
        ([, record]) => waitHealthy(record, deadline, probes.signal),
        (error: unknown) => {
          if (probes.signal.aborted) log("vm_wake_after_deadline_failed", { id, ...errorFields(error) });
          throw error;
        },
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const starting = new Promise<ResumeResult>((resolve, reject) => {
        timer = setTimeout(() => {
          if (recordVerified) resolve("starting");
          else reject(new LifecycleError("busy", "could not verify the VM before the wake deadline"));
          probes.abort();
        }, budget);
      });
      try {
        return await Promise.race([response, starting]);
      } finally {
        clearTimeout(timer);
      }
    },
    stop: (id) => enqueue(id, "stop", async () => stop(await load(id))),
    destroy: (id) => enqueue(id, "destroy", () => destroy(id)),
  };
}
