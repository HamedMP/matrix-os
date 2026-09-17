"use client";

import {
  DesktopSyncSnapshotSchema,
  BackupStatusSchema,
  SyncRemoteStatusResponseSchema,
  type BackupStatus,
  type SyncRemoteStatusResponse,
} from "@matrix-os/contracts";
import {
  SyncBackupView,
  type SyncBackupTransport,
} from "@matrix-os/ui";
import "@matrix-os/ui/sync-backup.css";
import { getGatewayUrl } from "@/lib/gateway";

const MAX_BACKUP_STATUS_BYTES = 32 * 1024;
const BACKUP_STATUS_TIMEOUT_MS = 10_000;

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BACKUP_STATUS_BYTES) {
        await reader.cancel();
        throw new Error("Backup status response exceeded its size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function browserSnapshot(
  backup: BackupStatus | null,
  remote: SyncRemoteStatusResponse | null,
  online: boolean,
) {
  return DesktopSyncSnapshotSchema.parse({
    schemaVersion: 1,
    capability: "unsupported_platform",
    helperVersion: null,
    service: "not_configured",
    profile: null,
    runtimeSlot: null,
    enabled: false,
    paused: false,
    auth: "unknown",
    connection: online ? "online" : "offline",
    status: "unavailable",
    activeTransferCount: 0,
    conflictCount: 0,
    lastSyncAt: null,
    mappings: [],
    backup,
    backupState: backup ? "available" : online ? "unavailable" : "offline",
    remoteStatus: remote ? {
      manifestVersion: remote.manifestVersion,
      fileCount: remote.fileCount,
      totalSize: remote.totalSize,
      lastSyncAt: remote.lastSyncAt || null,
      pendingConflicts: remote.pendingConflicts,
      connectedPeerCount: remote.connectedPeers.length,
    } : null,
  });
}

async function fetchBoundedStatus<T>(
  fetchFn: typeof fetch,
  url: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
): Promise<{ reachable: boolean; data: T | null }> {
  try {
    const response = await fetchFn(url, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(BACKUP_STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return { reachable: true, data: null };
    const parsed = schema.safeParse(await readBoundedJson(response));
    return { reachable: true, data: parsed.success ? parsed.data : null };
  } catch {
    return { reachable: false, data: null };
  }
}

export function createBrowserSyncTransport({
  gatewayUrl,
  fetchFn = fetch,
  openDesktop,
}: {
  gatewayUrl: string;
  fetchFn?: typeof fetch;
  openDesktop: () => void;
}): SyncBackupTransport {
  return {
    localFolderSync: false,
    openDesktop,
    async getSnapshot() {
      const [backup, remote] = await Promise.all([
        fetchBoundedStatus(fetchFn, `${gatewayUrl}/api/sync/backup-status`, BackupStatusSchema),
        fetchBoundedStatus(fetchFn, `${gatewayUrl}/api/sync/status`, SyncRemoteStatusResponseSchema),
      ]);
      return browserSnapshot(
        backup.data,
        remote.data,
        backup.reachable || remote.reachable,
      );
    },
  };
}

const browserSyncTransport = createBrowserSyncTransport({
  gatewayUrl: getGatewayUrl(),
  openDesktop: () => window.location.assign("matrixos://settings/sync-backup"),
});

export function SyncBackupSection() {
  return (
    <div className="mx-auto w-full max-w-4xl p-6 sm:p-8">
      <SyncBackupView transport={browserSyncTransport} />
    </div>
  );
}
