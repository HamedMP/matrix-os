import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVmStore, VmStoreError, type VmRecord } from "../../packages/hostd/src/vm-store.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hostd-store-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function record(overrides: Partial<VmRecord> = {}): VmRecord {
  return {
    id: "vm_0123456789abcdef01234567",
    machineId: "machine-1",
    generation: 1,
    handle: "alice",
    tier: "free",
    state: "running",
    privateIPv4: "10.78.0.10",
    mac: "52:54:00:78:00:0a",
    bootMiB: 2048,
    maxMiB: 8192,
    diskGiB: 20,
    chVersion: "v54.1",
    snapshot: null,
    updatedAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("VM store", () => {
  it("put then get round-trips a record and list returns it", async () => {
    const store = createVmStore(dir);
    const r = record({ snapshot: { dir: "/s/vm", takenAt: "2026-11-21T00:00:00.000Z", chVersion: "v54.1" } });
    await store.put(r);
    await expect(store.get(r.id)).resolves.toEqual(r);
    await expect(store.list()).resolves.toEqual([r]);
  });

  it("get returns null for an unknown id and rejects ids that are not vm_ plus 24 hex", async () => {
    const store = createVmStore(dir);
    await expect(store.get("vm_ffffffffffffffffffffffff")).resolves.toBeNull();
    await expect(store.get("../etc")).rejects.toBeInstanceOf(VmStoreError);
    await expect(store.put(record({ id: "vm_../../x" }))).rejects.toBeInstanceOf(VmStoreError);
  });

  it("put replaces atomically and leaves no temp files", async () => {
    const store = createVmStore(dir);
    await store.put(record());
    await store.put(record({ state: "suspended" }));
    const files = await readdir(join(dir, record().id));
    expect(files).toEqual(["record.json"]);
    expect(JSON.parse(await readFile(join(dir, record().id, "record.json"), "utf8")).state).toBe("suspended");
  });

  it("rejects a malformed record on put and a corrupt file on read", async () => {
    const store = createVmStore(dir);
    await expect(store.put({ ...record(), state: "dancing" } as unknown as VmRecord)).rejects.toBeInstanceOf(
      VmStoreError,
    );
    await store.put(record());
    await writeFile(join(dir, record().id, "record.json"), "{not json");
    await expect(store.get(record().id)).rejects.toBeInstanceOf(VmStoreError);
  });

  it("remove deletes the VM state directory and is idempotent", async () => {
    const store = createVmStore(dir);
    await store.put(record());
    await writeFile(join(dir, record().id, "seed.img"), "seed");
    await store.remove(record().id);
    await store.remove(record().id);
    await expect(store.get(record().id)).resolves.toBeNull();
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("list sweeps stale temp files and skips directories without a record", async () => {
    const store = createVmStore(dir);
    await store.put(record());
    const stale = join(dir, record().id, "record.json.deadbeef.tmp");
    await writeFile(stale, "partial");
    const old = new Date(Date.now() - 10 * 60_000);
    await utimes(stale, old, old);
    await store.put(record({ id: "vm_aaaaaaaaaaaaaaaaaaaaaaaa" }));
    await rm(join(dir, "vm_aaaaaaaaaaaaaaaaaaaaaaaa", "record.json"));
    await expect(store.list()).resolves.toEqual([record()]);
    expect(await readdir(join(dir, record().id))).toEqual(["record.json"]);
  });
});
