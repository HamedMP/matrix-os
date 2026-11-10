import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportCache } from "../../packages/gateway/src/ai-usage/history-service";
import { indexUsageRoots } from "../../packages/gateway/src/ai-usage/history-collector";
it("builds one report for simultaneous readers, reuses it briefly and rebuilds after new indexing", async () => {
  let now = 0, builds = 0, release = () => {};
  const cache = createReportCache(async (zone: string) => {
    builds++;
    await new Promise<void>((resolve) => (release = resolve));
    return { zone, builds };
  }, { ttlMs: 60_000, now: () => now });
  const first = cache.read("UTC"), second = cache.read("UTC");
  release();
  expect(await first).toBe(await second);
  expect(await cache.read("UTC")).toEqual({ zone: "UTC", builds: 1 });
  const other = cache.read("Europe/Stockholm");
  release();
  expect(await other).toEqual({ zone: "Europe/Stockholm", builds: 2 });
  now = 60_001;
  const expired = cache.read("UTC");
  release();
  expect((await expired).builds).toBe(3);
  cache.invalidate();
  const rebuilt = cache.read("UTC");
  release();
  expect((await rebuilt).builds).toBe(4);
});
it("does not keep a failed report and bounds the cached timezones", async () => {
  let fail = true, builds = 0;
  const cache = createReportCache(async (zone: string) => {
    builds++;
    if (fail) throw new Error("database unavailable");
    return zone;
  }, { ttlMs: 60_000, max: 2 });
  await expect(cache.read("UTC")).rejects.toThrow("database unavailable");
  fail = false;
  expect(await cache.read("UTC")).toBe("UTC");
  await cache.read("Asia/Tokyo");
  await cache.read("Europe/Paris");
  expect(cache.size()).toBe(2);
  await cache.read("UTC");
  expect(builds).toBe(5);
});
it("treats an absent standard agent folder as nothing to index, but a missing configured backup as a gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-roots-"));
  try {
    await mkdir(join(root, "present"));
    const repo = { getSource: vi.fn(), commit: vi.fn() } as never;
    expect(await indexUsageRoots(repo, "owner", "machine", [
      { path: join(root, "present"), agent: "claude", optional: true },
      { path: join(root, "absent"), agent: "codex", optional: true },
    ])).toEqual({ indexed: 0, failed: 0 });
    expect(await indexUsageRoots(repo, "owner", "machine", [
      { path: join(root, "absent"), agent: "codex" },
    ])).toEqual({ indexed: 0, failed: 1 });
  } finally {
    await rm(root, { recursive: true });
  }
});
