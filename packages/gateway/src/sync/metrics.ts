import { Counter, Histogram, Gauge } from "prom-client";
import { metricsRegistry } from "../metrics.js";

export const syncFilesSyncedTotal = new Counter({
  name: "sync_files_synced_total",
  help: "Total files synced",
  labelNames: ["action"] as const,
  registers: [metricsRegistry],
});

export const syncPresignRequestsTotal = new Counter({
  name: "sync_presign_requests_total",
  help: "Presigned URL requests",
  labelNames: ["action"] as const,
  registers: [metricsRegistry],
});

export const syncPresignDuration = new Histogram({
  name: "sync_presign_duration_seconds",
  help: "Presigned URL generation latency",
  labelNames: ["action"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});

export const syncCommitDuration = new Histogram({
  name: "sync_commit_duration_seconds",
  help: "Commit (manifest update) latency",
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

export const syncConflictsTotal = new Counter({
  name: "sync_conflicts_total",
  help: "Conflicts detected",
  labelNames: ["resolution"] as const,
  registers: [metricsRegistry],
});

export const syncManifestEntries = new Gauge({
  name: "sync_manifest_entries",
  help: "Latest observed manifest entry count",
  registers: [metricsRegistry],
});

export const syncManifestBytes = new Gauge({
  name: "sync_manifest_bytes",
  help: "Latest observed manifest total file size",
  registers: [metricsRegistry],
});

export const syncConnectedPeers = new Gauge({
  name: "sync_connected_peers",
  help: "Latest observed connected peer count",
  registers: [metricsRegistry],
});
