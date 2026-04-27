import { resolve, dirname } from "node:path";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureHome, loadHandle, saveIdentity, deriveAiHandle } from "@matrix-os/kernel";
import type { SyncReport } from "@matrix-os/kernel";
import { createGateway } from "./server.js";

try {
  process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env"));
} catch (err: unknown) {
  console.warn("[gateway] Could not load .env:", err instanceof Error ? err.message : String(err));
}

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
  await gateway.close();
  process.exit(0);
});
