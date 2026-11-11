import { expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReportCache } from "../../packages/gateway/src/ai-usage/history-service";
import { indexUsageRoots } from "../../packages/gateway/src/ai-usage/history-collector";
it("builds one report for simultaneous readers, reuses it briefly and rebuilds after new indexing", async () => {
  let now = 0, builds = 0, release = () => {};
  const cache = createReportCache(async (zone: string) => {
    const build = ++builds;
    await new Promise<void>((resolve) => (release = resolve));
    return { zone, builds: build };
  }, { ttlMs: 60_000, now: () => now });
  // Builds start after the queue yields, so wait for each to begin before finishing it.
  const finish = async (expected: number) => {
    await vi.waitFor(() => expect(builds).toBe(expected));
    release();
  };
  const first = cache.read("UTC"), second = cache.read("UTC");
  await finish(1);
  expect(await first).toBe(await second);
  expect(await cache.read("UTC")).toEqual({ zone: "UTC", builds: 1 });
  const other = cache.read("Europe/Stockholm");
  await finish(2);
  expect(await other).toEqual({ zone: "Europe/Stockholm", builds: 2 });
  now = 60_001;
  const expired = cache.read("UTC");
  await finish(3);
  expect((await expired).builds).toBe(3);
  cache.invalidate();
  const rebuilt = cache.read("UTC");
  await finish(4);
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
it("reports a folder that disappears inside an existing optional root as a gap", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-roots-"));
  try {
    for (const name of ["a", "b"]) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "session.jsonl"), "{}\n");
    }
    // Whichever folder is read first, the other vanishes before the walk reaches it.
    const getSource = vi.fn(async (_owner: string, _machine: string, path: string) => {
      await rm(join(root, path.includes(join(root, "a")) ? "b" : "a"), { recursive: true, force: true });
      throw new Error("stop after the first file");
    });
    const repo = { getSource, commit: vi.fn() } as never;
    const result = await indexUsageRoots(repo, "owner", "machine", [
      { path: root, agent: "claude", optional: true },
    ]);
    expect(getSource).toHaveBeenCalledOnce();
    expect(result).toEqual({ indexed: 0, failed: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("runs one full-history build at a time and keeps sharing an unfinished one, however many timezones ask", async () => {
  let active = 0, peak = 0, builds = 0;
  const releases: Array<() => void> = [];
  const cache = createReportCache(async (zone: string) => {
    builds++;
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
    return zone;
  }, { ttlMs: 60_000, max: 2 });
  const zones = ["UTC", "Asia/Tokyo", "Europe/Paris", "America/Lima", "Africa/Cairo"];
  const first = zones.map((zone) => cache.read(zone));
  const again = cache.read("UTC"); // Five other timezones are waiting; this must still join the first build.
  for (const _ of zones) {
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
  }
  expect(await Promise.all(first)).toEqual(zones);
  expect(await again).toBe("UTC");
  expect(peak).toBe(1);
  expect(builds).toBe(5);
  expect(cache.size()).toBe(2);
});
it("refuses more waiting timezones than it can hold, and does not keep a build that indexing has overtaken", async () => {
  const full = createReportCache(() => new Promise<string>(() => {}), { ttlMs: 1, maxWaiting: 2 });
  void full.read("UTC");
  void full.read("Asia/Tokyo");
  await expect(full.read("Europe/Paris")).rejects.toThrow("Usage report queue is full");
  let release = () => {}, builds = 0;
  const cache = createReportCache(async () => {
    const build = ++builds;
    await new Promise<void>((resolve) => (release = resolve));
    return build;
  }, { ttlMs: 60_000 });
  const stale = cache.read("UTC");
  await vi.waitFor(() => expect(builds).toBe(1));
  cache.invalidate();
  const fresh = cache.read("UTC");
  release();
  expect(await stale).toBe(1);
  await vi.waitFor(() => expect(builds).toBe(2));
  release();
  expect(await fresh).toBe(2);
  expect(await cache.read("UTC")).toBe(2);
});
