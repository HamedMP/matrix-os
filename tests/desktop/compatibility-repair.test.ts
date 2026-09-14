import { describe, expect, it, vi } from "vitest";
import { loadRepairPlan, repairVersions } from "@renderer/lib/compatibility-repair";
import type { ApiClient } from "@renderer/lib/api";

const version = "v2026.09.09-1";
const next = "v2026.09.09-2";
function fixture({ local = true, cloud = true, cloudBehind = false } = {}) {
  const source = { commit: "b".repeat(40), ancestors: ["a".repeat(40)] };
  const info = { version, runningVersion: version, updateChannel: "canary",
    build: { sha: cloudBehind ? "a".repeat(40) : source.commit } };
  const get = vi.fn(async (path: string) => path === "/api/system/info" ? info : {
    channel: "canary", latest: { version: cloud ? next : version }, updateAvailable: cloud,
  });
  const api = { get, post: vi.fn(async () => ({ version: next })) } as unknown as ApiClient;
  const snapshot = local ? { status: "ready", version: "0.2.0", progress: 100,
    release: { version: "0.2.0", notes: "Update" } } : { status: "up-to-date" };
  return { api, get, info, snapshot, source, readLocal: async () => ({ version: "0.1.0", snapshot, source }),
    signal: new AbortController().signal, isCurrent: () => true };
}

describe("one-button update planning", () => {
  it.each([[true, false, ["local"]], [false, true, ["cloud"]], [true, true, ["cloud", "local"]], [false, false, []]] as const)(
    "compares each component to its own channel (local %s, cloud %s)", async (local, cloud, targets) => {
      const plan = await loadRepairPlan(fixture({ local, cloud }));
      expect(plan.targets).toEqual(targets);
      expect(plan.local.installed).toBe("0.1.0");
      expect(plan.cloud.installed).toBe(version);
    });
  it("does not update Desktop when the missing cloud changes have no available update", async () => {
    const plan = await loadRepairPlan(fixture({ local: true, cloud: false, cloudBehind: true }));
    expect(plan.targets).toEqual([]);
    expect(plan.compatibilityUpdateRequired).toBe(true);
    expect(plan.reason).toContain("matching update is not available");
  });
  it.each([true, false])("selects only the required Desktop protocol update (available %s)", async (local) => {
    const f = fixture({ local, cloud: true, cloudBehind: true });
    Object.assign(f.info, { runtimeCompatibility: { schemaVersion: 1, minDesktopProtocol: 2, maxDesktopProtocol: 2 } });
    const plan = await loadRepairPlan(f);
    expect(plan.targets).toEqual(local ? ["local"] : []);
    expect(plan.compatibilityUpdateRequired).toBe(true);
    expect(plan.reason).toContain("desktop app must be updated");
  });
  it("keeps an installed cloud update pending until its services restart", async () => {
    const f = fixture({ local: false, cloud: false });
    f.info.runningVersion = "v2026.09.08-1";
    const plan = await loadRepairPlan(f);
    expect(plan.cloud.state).toBe("pending");
    expect(plan.targets).toEqual([]);
    expect(plan.reason).toContain("previous version");
  });
  it("does not treat missing metadata or a failed manifest check as a proven older version", async () => {
    const f = fixture({ local: false });
    f.get.mockImplementation(async (path) => path === "/api/system/info" ? f.info : { error: "private provider details" } as never);
    const plan = await loadRepairPlan(f);
    expect(plan.targets).toEqual([]);
    expect(plan.cloud.state).toBe("unavailable");
    expect(JSON.stringify(plan)).not.toContain("private provider");
  });
});

describe("one-button execution", () => {
  it("updates cloud first, waits for running services, then installs the latest desktop app", async () => {
    const f = fixture();
    const plan = await loadRepairPlan(f);
    const order: string[] = [];
    f.api.post = vi.fn(async () => { order.push("cloud"); return { version: next } as never; });
    f.get.mockResolvedValueOnce({ ...f.info, release: { version: next } } as never)
      .mockResolvedValueOnce({ ...f.info, version: next, runningVersion: next, release: { version: next } } as never);
    const installLocal = vi.fn(async () => { order.push("local"); return { ok: true }; });
    await repairVersions(plan, { ...f, checkLocal: async () => f.snapshot, getLocal: async () => f.snapshot,
      installLocal, progress: vi.fn(), pause: async () => undefined });
    expect(order).toEqual(["cloud", "local"]);
    expect(f.api.post).toHaveBeenCalledWith("/api/system/update", { version: next }, expect.objectContaining({ signal: f.signal }));
    expect(f.get).toHaveBeenCalledTimes(4);
  });
  it("fences a switched computer before any update mutation", async () => {
    const f = fixture();
    const plan = await loadRepairPlan(f);
    const installLocal = vi.fn();
    await expect(repairVersions(plan, { ...f, isCurrent: () => false, checkLocal: async () => f.snapshot,
      getLocal: async () => f.snapshot, installLocal, progress: vi.fn(), pause: async () => undefined })).rejects.toThrow();
    expect(f.api.post).not.toHaveBeenCalled();
    expect(installLocal).not.toHaveBeenCalled();
  });
  it("never restarts locally when the cloud update request fails", async () => {
    const f = fixture();
    const plan = await loadRepairPlan(f);
    f.api.post = vi.fn().mockRejectedValue(new Error("timeout"));
    const installLocal = vi.fn();
    await expect(repairVersions(plan, { ...f, checkLocal: async () => f.snapshot,
      getLocal: async () => f.snapshot, installLocal, progress: vi.fn(), pause: async () => undefined })).rejects.toThrow();
    expect(installLocal).not.toHaveBeenCalled();
  });
  it("waits for a superseding local download instead of installing the stale package", async () => {
    const f = fixture({ cloud: false });
    const plan = await loadRepairPlan(f);
    const installLocal = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    const getLocal = vi.fn().mockResolvedValueOnce({ status: "downloading", version: "0.3.0" })
      .mockResolvedValue({ ...f.snapshot, version: "0.3.0", release: { version: "0.3.0", notes: "Latest" } });
    await repairVersions(plan, { ...f, checkLocal: async () => f.snapshot, getLocal,
      installLocal, progress: vi.fn(), pause: async () => undefined });
    expect(installLocal).toHaveBeenCalledTimes(2);
  });
});
