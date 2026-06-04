import { mkdtemp, mkdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildDockerCleanupPlan,
  collectHostBundleCandidates,
  isHostBundlePath,
  runHostBundleCleanup,
} from "../../scripts/cleanup-local-artifacts.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;

async function touchOld(path: string, now: Date, ageDays: number) {
  const timestamp = new Date(now.getTime() - ageDays * DAY_MS);
  await utimes(path, timestamp, timestamp);
}

describe("cleanup-local-artifacts", () => {
  it("only treats dist/host-bundle paths as removable host bundle artifacts", () => {
    expect(isHostBundlePath("/repo/dist/host-bundle")).toBe(true);
    expect(isHostBundlePath("/repo/dist/host-bundle/")).toBe(true);
    expect(isHostBundlePath("/repo/system-bundles/v1")).toBe(false);
    expect(isHostBundlePath("/repo/dist/not-host-bundle")).toBe(false);
    expect(isHostBundlePath("/repo/home/system/host-bundle")).toBe(false);
  });

  it("collects old host bundles under approved roots and skips newer or unrelated paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-cleanup-"));
    const now = new Date("2026-06-04T12:00:00.000Z");
    const oldBundle = join(root, "matrix-os-a", "dist", "host-bundle");
    const newBundle = join(root, "matrix-os-b", "dist", "host-bundle");
    const unrelated = join(root, "matrix-os-c", "system-bundles", "v1");

    await mkdir(oldBundle, { recursive: true });
    await mkdir(newBundle, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await writeFile(join(oldBundle, "matrix-host-bundle.tar.gz"), "old");
    await writeFile(join(newBundle, "matrix-host-bundle.tar.gz"), "new");
    await touchOld(oldBundle, now, 8);
    await touchOld(newBundle, now, 1);

    const candidates = await collectHostBundleCandidates({
      roots: [root],
      olderThanDays: 3,
      now,
    });

    expect(candidates.map((candidate) => candidate.path)).toEqual([oldBundle]);
  });

  it("keeps dry-run cleanup non-destructive and applies only eligible bundle removals", async () => {
    const root = await mkdtemp(join(tmpdir(), "matrix-cleanup-"));
    const now = new Date("2026-06-04T12:00:00.000Z");
    const oldBundle = join(root, "matrix-os-a", "dist", "host-bundle");
    const newBundle = join(root, "matrix-os-b", "dist", "host-bundle");

    await mkdir(oldBundle, { recursive: true });
    await mkdir(newBundle, { recursive: true });
    await writeFile(join(oldBundle, "matrix-host-bundle.tar.gz"), "old");
    await writeFile(join(newBundle, "matrix-host-bundle.tar.gz"), "new");
    await touchOld(oldBundle, now, 8);
    await touchOld(newBundle, now, 1);

    const dryRun = await runHostBundleCleanup({
      roots: [root],
      olderThanDays: 3,
      now,
      dryRun: true,
    });

    expect(dryRun.removed).toEqual([]);
    await expect(stat(oldBundle)).resolves.toBeTruthy();

    const applied = await runHostBundleCleanup({
      roots: [root],
      olderThanDays: 3,
      now,
      dryRun: false,
    });

    expect(applied.removed.map((candidate) => candidate.path)).toEqual([oldBundle]);
    await expect(stat(oldBundle)).rejects.toThrow();
    await expect(stat(newBundle)).resolves.toBeTruthy();
  });

  it("plans Docker image and builder cleanup without volume pruning", () => {
    const plan = buildDockerCleanupPlan({
      includeDocker: true,
      pruneImages: true,
      pruneBuilder: true,
      imageUntil: "168h",
      builderKeepStorage: "20GB",
    });

    expect(plan).toEqual([
      {
        command: "docker",
        args: ["image", "prune", "--all", "--force", "--filter", "until=168h"],
      },
      {
        command: "docker",
        args: ["builder", "prune", "--all", "--force", "--keep-storage", "20GB"],
      },
    ]);
    expect(plan.flatMap((entry) => entry.args)).not.toContain("volume");
  });
});
