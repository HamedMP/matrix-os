import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ActivityHistoryStore, AutoCleanupPolicyStore } from "../../packages/gateway/src/system-activity/history.js";

async function tmpHome() {
  const homePath = await mkdtemp(join(tmpdir(), "activity-history-"));
  await mkdir(join(homePath, "system"), { recursive: true });
  return homePath;
}

describe("system activity history and policy stores", () => {
  it("stores bounded cleanup history newest-first", async () => {
    const homePath = await tmpHome();
    try {
      const store = new ActivityHistoryStore({ homePath });
      await store.append({
        actor: "owner",
        actionType: "stop_stale_app_server",
        targetLabel: "preview server",
        result: "completed",
        reclaimedBytes: 100,
        reasonCode: "stale_app_server_no_connections",
      });
      await store.append({
        actor: "owner",
        actionType: "clean_cache_scope",
        targetLabel: "npm cache",
        result: "skipped",
        reasonCode: "manual_review",
      });

      const page = await store.list({ limit: 1 });

      expect(page.entries).toHaveLength(1);
      expect(page.entries[0].actionType).toBe("clean_cache_scope");
      expect(page.nextCursor).toBe(page.entries[0].id);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("uses stable id cursors when new history entries are prepended", async () => {
    const homePath = await tmpHome();
    try {
      const store = new ActivityHistoryStore({ homePath });
      await store.append({
        actor: "owner",
        actionType: "stop_stale_app_server",
        targetLabel: "old preview server",
        result: "completed",
        reclaimedBytes: 100,
        reasonCode: "stale_app_server_no_connections",
      });
      await store.append({
        actor: "owner",
        actionType: "clean_cache_scope",
        targetLabel: "npm cache",
        result: "skipped",
        reasonCode: "manual_review",
      });

      const firstPage = await store.list({ limit: 1 });
      await store.append({
        actor: "owner",
        actionType: "prune_old_bundle",
        targetLabel: "old bundle",
        result: "completed",
        reclaimedBytes: 200,
        reasonCode: "inactive_bundle",
      });
      const secondPage = await store.list({ limit: 1, cursor: firstPage.nextCursor ?? undefined });

      expect(secondPage.entries).toHaveLength(1);
      expect(secondPage.entries[0].actionType).toBe("stop_stale_app_server");
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("falls back to disabled policy for missing or malformed files", async () => {
    const homePath = await tmpHome();
    try {
      const store = new AutoCleanupPolicyStore({ homePath });
      expect(await store.read()).toMatchObject({
        enabled: false,
        allowedTypes: [],
        gracePeriodSeconds: 1800,
        maxActionsPerHour: 3,
      });

      await writeFile(join(homePath, "system", "activity-monitor-policy.json"), "{bad json");
      expect(await store.read()).toMatchObject({ enabled: false, allowedTypes: [] });
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });

  it("writes auto-clean policy atomically with a server timestamp", async () => {
    const homePath = await tmpHome();
    try {
      const store = new AutoCleanupPolicyStore({ homePath });

      const saved = await store.save({
        enabled: true,
        allowedTypes: ["stop_stale_app_server"],
        gracePeriodSeconds: 3600,
        maxActionsPerHour: 2,
      });

      expect(saved.lastUpdatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      await expect(store.read()).resolves.toEqual(saved);
    } finally {
      await rm(homePath, { recursive: true, force: true });
    }
  });
});
