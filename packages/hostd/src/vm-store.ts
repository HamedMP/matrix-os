import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Per-VM state of record on this host: one JSON file per VM at
// <dir>/<id>/record.json, written atomically (exclusive temp file + rename).
// The same <dir>/<id>/ directory holds the VM's seed image and unit.env.

export type VmTier = "free" | "paid";
export type VmState = "creating" | "running" | "suspending" | "suspended" | "resuming" | "stopped" | "failed";

export interface VmSnapshotRef {
  dir: string;
  takenAt: string;
  chVersion: string;
}

export interface VmRecord {
  id: string;
  machineId: string;
  generation: number;
  handle: string;
  tier: VmTier;
  state: VmState;
  privateIPv4: string;
  mac: string;
  bootMiB: number;
  maxMiB: number;
  diskGiB: number;
  chVersion: string;
  snapshot: VmSnapshotRef | null;
  updatedAt: string;
}

export interface VmStore {
  get(id: string): Promise<VmRecord | null>;
  list(): Promise<VmRecord[]>;
  put(record: VmRecord): Promise<void>;
  remove(id: string): Promise<void>;
  vmDir(id: string): string;
  // Notifies after a successful put or remove through this store instance.
  // Returns an unsubscribe function. Listeners are capped per store.
  onChange(listener: (id: string) => void): () => void;
}

export interface VmStoreOptions {
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export const MAX_CHANGE_LISTENERS = 64;

export class VmStoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VmStoreError";
  }
}

export const VM_ID_PATTERN = /^vm_[0-9a-f]{24}$/;
const RECORD_FILE = "record.json";
const TEMP_SUFFIX = ".tmp";
const STALE_TEMP_MS = 60_000;
const MAX_RECORD_BYTES = 64 * 1024;
const TIERS: ReadonlySet<string> = new Set<VmTier>(["free", "paid"]);
const STATES: ReadonlySet<string> = new Set<VmState>([
  "creating",
  "running",
  "suspending",
  "suspended",
  "resuming",
  "stopped",
  "failed",
]);

export function isVmId(id: string): boolean {
  return VM_ID_PATTERN.test(id);
}

function assertId(id: string): void {
  if (!isVmId(id)) throw new VmStoreError("invalid VM id");
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

const isString = (v: unknown, max = 256): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function isSnapshot(v: unknown): v is VmSnapshotRef {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return isString(s.dir, 4096) && isString(s.takenAt) && isString(s.chVersion);
}

export function parseVmRecord(value: unknown): VmRecord {
  if (typeof value !== "object" || value === null) throw new VmStoreError("invalid VM record");
  const r = value as Record<string, unknown>;
  const valid =
    typeof r.id === "string" &&
    isVmId(r.id) &&
    isString(r.machineId) &&
    isCount(r.generation) &&
    isString(r.handle) &&
    typeof r.tier === "string" &&
    TIERS.has(r.tier) &&
    typeof r.state === "string" &&
    STATES.has(r.state) &&
    isString(r.privateIPv4, 15) &&
    isString(r.mac, 17) &&
    isCount(r.bootMiB) &&
    isCount(r.maxMiB) &&
    isCount(r.diskGiB) &&
    isString(r.chVersion) &&
    (r.snapshot === null || isSnapshot(r.snapshot)) &&
    isString(r.updatedAt);
  if (!valid) throw new VmStoreError("invalid VM record");
  const snapshot = r.snapshot as VmSnapshotRef | null;
  return {
    id: r.id as string,
    machineId: r.machineId as string,
    generation: r.generation as number,
    handle: r.handle as string,
    tier: r.tier as VmTier,
    state: r.state as VmState,
    privateIPv4: r.privateIPv4 as string,
    mac: r.mac as string,
    bootMiB: r.bootMiB as number,
    maxMiB: r.maxMiB as number,
    diskGiB: r.diskGiB as number,
    chVersion: r.chVersion as string,
    snapshot: snapshot === null ? null : { dir: snapshot.dir, takenAt: snapshot.takenAt, chVersion: snapshot.chVersion },
    updatedAt: r.updatedAt as string,
  };
}

// Writes `data` to `path` atomically: an exclusive (`wx`) temp file beside it,
// then rename. The temp file is removed on failure; crash leftovers end in
// `.tmp` and are swept by the store's list().
export async function writeFileAtomic(path: string, data: string, mode = 0o600): Promise<void> {
  const temp = `${path}.${randomBytes(8).toString("hex")}${TEMP_SUFFIX}`;
  try {
    await writeFile(temp, data, { flag: "wx", mode });
    await rename(temp, path);
  } catch (error: unknown) {
    await rm(temp, { force: true });
    throw error;
  }
}

async function sweepStaleTemps(dir: string, now: number): Promise<void> {
  for (const name of await readdir(dir)) {
    if (!name.endsWith(TEMP_SUFFIX)) continue;
    const path = join(dir, name);
    const info = await lstat(path);
    if (!info.isFile() || now - info.mtimeMs < STALE_TEMP_MS) continue;
    try {
      await unlink(path);
    } catch (error: unknown) {
      if (errnoCode(error) !== "ENOENT") throw error;
    }
  }
}

export function createVmStore(dir: string, options: VmStoreOptions = {}): VmStore {
  const log = options.log ?? ((event, fields) => console.error(JSON.stringify({ event, ...fields })));
  const listeners = new Set<(id: string) => void>();

  function notify(id: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(id);
      } catch (error: unknown) {
        log("vm_store.listener_failed", {
          id,
          error: error instanceof Error ? error.name : String(error),
          message: error instanceof Error ? error.message : undefined,
        });
      }
    }
  }

  const vmDir = (id: string) => {
    assertId(id);
    return join(dir, id);
  };

  async function get(id: string): Promise<VmRecord | null> {
    let text: string;
    try {
      text = await readFile(join(vmDir(id), RECORD_FILE), "utf8");
    } catch (error: unknown) {
      if (errnoCode(error) === "ENOENT") return null;
      throw error;
    }
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new VmStoreError("VM record too large");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) throw new VmStoreError("corrupt VM record", { cause: error });
      throw error;
    }
    return parseVmRecord(parsed);
  }

  return {
    vmDir,
    get,
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (error: unknown) {
        if (errnoCode(error) === "ENOENT") return [];
        throw error;
      }
      const now = Date.now();
      const records: VmRecord[] = [];
      for (const name of names.sort()) {
        if (!isVmId(name)) continue;
        const info = await lstat(join(dir, name));
        if (!info.isDirectory()) continue;
        await sweepStaleTemps(join(dir, name), now);
        const record = await get(name);
        if (record !== null) records.push(record);
      }
      return records;
    },
    async put(record) {
      const valid = parseVmRecord(record);
      const target = vmDir(valid.id);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await writeFileAtomic(join(target, RECORD_FILE), `${JSON.stringify(valid, null, 2)}\n`);
      notify(valid.id);
    },
    async remove(id) {
      await rm(vmDir(id), { recursive: true, force: true });
      notify(id);
    },
    onChange(listener) {
      if (listeners.size >= MAX_CHANGE_LISTENERS) throw new VmStoreError("too many change listeners");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
