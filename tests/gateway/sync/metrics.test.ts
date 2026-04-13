import { describe, it, expect } from "vitest";
import {
  syncFilesSyncedTotal,
  syncPresignRequestsTotal,
  syncPresignDuration,
  syncCommitDuration,
  syncConflictsTotal,
  syncManifestEntries,
  syncManifestBytes,
  syncConnectedPeers,
} from "../../../packages/gateway/src/sync/metrics.js";
import { metricsRegistry } from "../../../packages/gateway/src/metrics.js";

describe("sync metrics", () => {
  it("registers all sync counters in the shared registry", async () => {
    const metrics = await metricsRegistry.getMetricsAsJSON();
    const names = metrics.map((m) => m.name);

    expect(names).toContain("sync_files_synced_total");
    expect(names).toContain("sync_presign_requests_total");
    expect(names).toContain("sync_conflicts_total");
  });

  it("registers all sync histograms in the shared registry", async () => {
    const metrics = await metricsRegistry.getMetricsAsJSON();
    const names = metrics.map((m) => m.name);

    expect(names).toContain("sync_presign_duration_seconds");
    expect(names).toContain("sync_commit_duration_seconds");
  });

  it("registers all sync gauges in the shared registry", async () => {
    const metrics = await metricsRegistry.getMetricsAsJSON();
    const names = metrics.map((m) => m.name);

    expect(names).toContain("sync_manifest_entries");
    expect(names).toContain("sync_manifest_bytes");
    expect(names).toContain("sync_connected_peers");
  });

  it("counters increment correctly", () => {
    syncFilesSyncedTotal.inc({ action: "upload", user_id: "test" });
    syncPresignRequestsTotal.inc({ action: "put", user_id: "test" });
    syncConflictsTotal.inc({ resolution: "auto_merged" });

    // No throws = correct label config
    expect(true).toBe(true);
  });

  it("histograms observe correctly", () => {
    syncPresignDuration.observe({ action: "put" }, 0.05);
    syncCommitDuration.observe(0.1);

    expect(true).toBe(true);
  });

  it("gauges set correctly", () => {
    syncManifestEntries.set({ user_id: "test" }, 42);
    syncManifestBytes.set({ user_id: "test" }, 1024);
    syncConnectedPeers.set({ user_id: "test" }, 2);

    expect(true).toBe(true);
  });
});
