import { describe, expect, it, vi } from "vitest";
import { createSitePublicAppResolver } from "../../packages/gateway/src/sites/public-app-resolver.js";

const record = { tables: { tasks: { columns: { title: "text" } } }, installed_version: "1.0.0" };

describe("public site app resolution", () => {
  it("does not rescan the apps directory on every visitor request for an app with no record", async () => {
    let clock = 0;
    const ensureProvisioned = vi.fn(async () => {});
    const getRecord = vi.fn(async () => null);
    const resolve = createSitePublicAppResolver({ ensureProvisioned, getRecord, missTtlMs: 1_000, now: () => clock });
    for (let i = 0; i < 5; i += 1) expect(await resolve("ghost")).toBeNull();
    expect(ensureProvisioned).toHaveBeenCalledTimes(1);
    clock = 1_001;
    expect(await resolve("ghost")).toBeNull();
    expect(ensureProvisioned).toHaveBeenCalledTimes(2);
  });

  it("serves an app the owner provisions during the miss window, and a newly published one after it", async () => {
    let clock = 0;
    let registered: typeof record | null = null;
    let onDisk = false;
    const ensureProvisioned = vi.fn(async () => { if (onDisk) registered = record; });
    const resolve = createSitePublicAppResolver({ ensureProvisioned, getRecord: async () => registered, missTtlMs: 1_000, now: () => clock });
    expect(await resolve("fresh")).toBeNull();
    // The owner bridge registered it: the registry is still read inside the miss window.
    registered = record;
    expect(await resolve("fresh")).toBe(record);
    registered = null;
    onDisk = true;
    expect(await resolve("fresh")).toBe(record);
    expect(ensureProvisioned).toHaveBeenCalledTimes(2);
  });

  it("does not remember a miss when the registry read fails", async () => {
    const ensureProvisioned = vi.fn(async () => {});
    const getRecord = vi.fn().mockRejectedValueOnce(new Error("connection lost")).mockResolvedValue(null);
    const resolve = createSitePublicAppResolver({ ensureProvisioned, getRecord, now: () => 0 });
    await expect(resolve("flaky")).rejects.toThrow("connection lost");
    await resolve("flaky");
    expect(ensureProvisioned).toHaveBeenCalledTimes(2);
  });

  it("caps remembered misses and evicts the oldest", async () => {
    const ensureProvisioned = vi.fn(async () => {});
    const resolve = createSitePublicAppResolver({ ensureProvisioned, getRecord: async () => null, maxMisses: 2, now: () => 0 });
    for (const slug of ["a", "b", "c"]) await resolve(slug);
    expect(resolve.size).toBe(2);
    await resolve("a");
    expect(ensureProvisioned).toHaveBeenCalledTimes(4);
    await resolve("c");
    expect(ensureProvisioned).toHaveBeenCalledTimes(4);
  });
});
