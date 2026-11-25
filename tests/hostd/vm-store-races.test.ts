import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A concurrent put() renames a temp file, and a concurrent remove() deletes a
// whole VM directory, between list()'s readdir and its lstat. `beforeLstat`
// lets a test delete the path at exactly that point.
const hooks = vi.hoisted(() => ({ beforeLstat: null as null | ((path: string) => Promise<void>) }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: async (path: string) => {
      if (hooks.beforeLstat !== null) await hooks.beforeLstat(path);
      return actual.lstat(path);
    },
  };
});

const { createVmStore } = await import("../../packages/hostd/src/vm-store.js");
type VmRecord = import("../../packages/hostd/src/vm-store.js").VmRecord;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "hostd-store-race-"));
});

afterEach(async () => {
  hooks.beforeLstat = null;
  await rm(dir, { recursive: true, force: true });
});

function record(id: string): VmRecord {
  return {
    id,
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
  };
}

const A = "vm_0123456789abcdef01234567";
const B = "vm_76543210fedcba9876543210";

describe("VM store list under concurrent writes", () => {
  it("skips a temp file that a concurrent put() renamed away", async () => {
    const store = createVmStore(dir);
    await store.put(record(A));
    const temp = join(dir, A, "vm.json.0011223344556677.tmp");
    await writeFile(temp, "{}");
    await utimes(temp, new Date(0), new Date(0));
    hooks.beforeLstat = async (path) => {
      if (path === temp) await rm(temp, { force: true });
    };
    await expect(store.list()).resolves.toEqual([record(A)]);
  });

  it("skips a VM directory that a concurrent remove() deleted and still lists the rest", async () => {
    const store = createVmStore(dir);
    await store.put(record(A));
    await store.put(record(B));
    hooks.beforeLstat = async (path) => {
      if (path === join(dir, A)) await rm(join(dir, A), { recursive: true, force: true });
    };
    await expect(store.list()).resolves.toEqual([record(B)]);
  });

  it("still surfaces lstat errors other than ENOENT", async () => {
    const store = createVmStore(dir);
    await store.put(record(A));
    hooks.beforeLstat = async (path) => {
      if (path === join(dir, A)) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    await expect(store.list()).rejects.toThrow(/EACCES/);
  });
});
