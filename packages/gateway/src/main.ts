import { resolve, dirname } from "node:path";
import { join } from "node:path";
import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { ensureHome, loadHandle, saveIdentity, deriveAiHandle } from "@matrix-os/kernel";
import type { SyncReport } from "@matrix-os/kernel";
import {
  createPostHogErrorTracker,
  installPostHogProcessErrorTracking,
  resolveOwnerTelemetryDistinctId,
} from "@matrix-os/observability";
import { createGateway } from "./server.js";
import { tryRegisterAgentBridges } from "./shell/agent-session-bridges.js";

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch (err: unknown) {
  console.warn("[gateway] Could not load .env:", err instanceof Error ? err.message : String(err));
}

const processPosthogErrorTracker = createPostHogErrorTracker({
  service: "matrix-gateway",
});
const posthogProcessErrors = installPostHogProcessErrorTracking({
  tracker: processPosthogErrorTracker,
  service: "matrix-gateway",
  distinctId: resolveOwnerTelemetryDistinctId(),
});

const syncResult = ensureHome(process.env.MATRIX_HOME || undefined);
const homePath = syncResult.homePath;

// Populate handle.json from env vars (set by platform/Clerk at provisioning time)
const existingHandle = loadHandle(homePath);
if (!existingHandle.handle && process.env.MATRIX_HANDLE) {
  const handle = process.env.MATRIX_HANDLE;
  const displayName = process.env.MATRIX_DISPLAY_NAME || handle;
  saveIdentity(homePath, {
    handle,
    aiHandle: deriveAiHandle(handle),
    displayName,
    createdAt: new Date().toISOString(),
  });
}
const syncReport: SyncReport = {
  added: syncResult.added,
  updated: syncResult.updated,
  skipped: syncResult.skipped,
};
const port = Number(process.env.PORT ?? 4000);

await tryRegisterAgentBridges({ homePath });

// T2093: Store sync report for WebSocket notification
const hasChanges = syncReport.added.length > 0 || syncReport.updated.length > 0;
if (hasChanges) {
  const lastSyncPath = join(homePath, "system", "last-sync.json");
  try {
    mkdirSync(dirname(lastSyncPath), { recursive: true });
    await writeFile(lastSyncPath, JSON.stringify({
      ...syncReport,
      timestamp: new Date().toISOString(),
    }, null, 2));
  } catch (err: unknown) {
    console.warn("[gateway] Could not write template sync report:", err instanceof Error ? err.message : String(err));
  }
}

const gateway = await createGateway({ homePath, port, syncReport: hasChanges ? syncReport : undefined });

console.log(`Matrix OS gateway running on http://localhost:${port}`);
console.log(`Home directory: ${homePath}`);
if (hasChanges) {
  console.log(`Template sync: ${syncReport.updated.length} updated, ${syncReport.added.length} added, ${syncReport.skipped.length} skipped`);
}

const proxyUrl = process.env.PROXY_URL;
if (proxyUrl) {
  const identity = loadHandle(homePath);
  const handle = identity.handle || process.env.MATRIX_HANDLE || 'anonymous';
  const shellPort = Number(process.env.SHELL_PORT ?? 3000);
  const gatewayUrl = process.env.GATEWAY_EXTERNAL_URL ?? `http://${handle}:${port}`;
  fetch(`${proxyUrl}/instances/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle, gatewayUrl, shellPort }),
    signal: AbortSignal.timeout(10_000),
  }).then(() => console.log(`Registered with proxy as "${handle}"`))
    .catch((e) => console.warn(`Proxy registration failed: ${(e as Error).message}`));
}

process.on("SIGINT", async () => {
  posthogProcessErrors.dispose();
  await gateway.close();
  await processPosthogErrorTracker.shutdown();
  process.exit(0);
});

// Heap snapshot on SIGUSR2 — `kill -USR2 <gateway-pid>` writes a .heapsnapshot
// file under <home>/system/heap-snapshots/ that Chrome DevTools can load.
// Lets us profile a leaking live process without restarting under --inspect.
// Retention: keep only the most recent MAX_HEAP_SNAPSHOTS files so a stuck
// SIGUSR2 loop or a long profiling session can't fill the owner home and
// take the gateway down — each snapshot is a full V8 heap (often 100MB+).
const MAX_HEAP_SNAPSHOTS = 5;

function pruneOldHeapSnapshots(dir: string): void {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.startsWith("gateway-") && f.endsWith(".heapsnapshot"))
      .sort();
  } catch (err: unknown) {
    console.warn("[gateway] Could not enumerate heap snapshots for pruning:", err instanceof Error ? err.message : String(err));
    return;
  }
  while (files.length >= MAX_HEAP_SNAPSHOTS) {
    const oldest = files.shift()!;
    try {
      unlinkSync(join(dir, oldest));
    } catch (err: unknown) {
      console.warn("[gateway] Could not delete old heap snapshot:", err instanceof Error ? err.message : String(err));
    }
  }
}

process.on("SIGUSR2", () => {
  try {
    const dir = join(homePath, "system", "heap-snapshots");
    mkdirSync(dir, { recursive: true });
    pruneOldHeapSnapshots(dir);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `gateway-${stamp}-${process.pid}.heapsnapshot`);
    console.log(`[gateway] Writing heap snapshot to ${file}`);
    const written = writeHeapSnapshot(file);
    console.log(`[gateway] Heap snapshot written: ${written}`);
  } catch (err: unknown) {
    console.error("[gateway] Failed to write heap snapshot:", err instanceof Error ? err.message : String(err));
  }
});
