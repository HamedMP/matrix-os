import { z } from "zod/v4";

export const ManifestEntrySchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  size: z.int().nonnegative(),
  mtime: z.int().nonnegative(),
  peerId: z.string().min(1).max(128),
  version: z.int().nonnegative(),
  deleted: z.boolean().optional(),
  deletedAt: z.int().nonnegative().optional(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  version: z.literal(2),
  files: z.record(z.string().min(1).max(1024), ManifestEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const RemoteManifestEnvelopeSchema = z.object({
  manifestVersion: z.int().nonnegative().optional().default(0),
  manifest: ManifestSchema,
});
export type RemoteManifestEnvelope = z.infer<typeof RemoteManifestEnvelopeSchema>;

export const LocalFileStateSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  mtime: z.int().nonnegative(),
  size: z.int().nonnegative(),
  lastSyncedHash: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
});
export type LocalFileState = z.infer<typeof LocalFileStateSchema>;

export const SyncStateSchema = z.object({
  manifestVersion: z.int().nonnegative(),
  lastSyncAt: z.int().nonnegative(),
  files: z.record(z.string(), LocalFileStateSchema),
});
export type SyncState = z.infer<typeof SyncStateSchema>;

export const PeerInfoSchema = z.object({
  peerId: z.string().min(1).max(128),
  userId: z.string().min(1).max(256),
  hostname: z.string().max(256),
  platform: z.enum(["darwin", "linux", "win32"]),
  clientVersion: z.string().max(64),
  connectedAt: z.int().nonnegative(),
});
export type PeerInfo = z.infer<typeof PeerInfoSchema>;

export const ConflictRecordSchema = z.object({
  path: z.string().min(1).max(1024),
  conflictPath: z.string().min(1),
  localHash: z.string(),
  remoteHash: z.string(),
  remotePeerId: z.string(),
  detectedAt: z.int().nonnegative(),
  resolved: z.boolean().default(false),
  resolvedAt: z.int().nonnegative().optional(),
});
export type ConflictRecord = z.infer<typeof ConflictRecordSchema>;

export type SyncChangeEvent = {
  type: "sync:change";
  path: string;
  hash: string;
  peerId: string;
  action: "create" | "update" | "delete";
};

export type SyncConflictEvent = {
  type: "sync:conflict";
  path: string;
  localHash: string;
  remoteHash: string;
  conflictPath: string;
};

export type SyncEvent = SyncChangeEvent | SyncConflictEvent;

export const DAEMON_IPC_VERSION = 1;

export const DaemonRequestSchema = z.object({
  id: z.string().min(1).max(128),
  v: z.literal(DAEMON_IPC_VERSION),
  command: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});
export type DaemonRequest = z.infer<typeof DaemonRequestSchema>;

export const DaemonErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(256),
});
export type DaemonError = z.infer<typeof DaemonErrorSchema>;

export const DaemonSuccessResponseSchema = z.object({
  id: z.string().min(1).max(128),
  v: z.literal(DAEMON_IPC_VERSION),
  result: z.record(z.string(), z.unknown()),
});
export type DaemonSuccessResponse = z.infer<typeof DaemonSuccessResponseSchema>;

export const DaemonErrorResponseSchema = z.object({
  id: z.string().min(1).max(128),
  v: z.literal(DAEMON_IPC_VERSION),
  error: DaemonErrorSchema,
});
export type DaemonErrorResponse = z.infer<typeof DaemonErrorResponseSchema>;

export type DaemonResponse = DaemonSuccessResponse | DaemonErrorResponse;

const ALLOWED_DAEMON_COMMANDS = new Set([
  "auth.whoami",
  "auth.token",
  "auth.refresh",
  "shell.list",
  "shell.create",
  "shell.destroy",
  "tab.list",
  "tab.create",
  "tab.go",
  "tab.close",
  "pane.split",
  "pane.close",
  "layout.list",
  "layout.show",
  "layout.save",
  "layout.apply",
  "layout.delete",
  "status",
  "pause",
  "resume",
  "getConfig",
  "setSyncPath",
  "setGatewayFolder",
  "restart",
  "logout",
  "sync.status",
  "sync.pause",
  "sync.resume",
  "sync.events",
]);

const DAEMON_ERROR_MESSAGES: Record<string, string> = {
  invalid_request: "Invalid request",
  unknown_command: "Unknown command",
  unsupported_version: "Unsupported protocol version",
};

export function formatDaemonSuccess(
  id: string,
  result: Record<string, unknown>,
): DaemonSuccessResponse {
  return { id, v: DAEMON_IPC_VERSION, result };
}

export function formatDaemonError(
  id: string,
  code: string,
  message = DAEMON_ERROR_MESSAGES[code] ?? "Request failed",
): DaemonErrorResponse {
  return {
    id,
    v: DAEMON_IPC_VERSION,
    error: { code, message },
  };
}

export function parseDaemonRequest(
  raw: unknown,
): { ok: true; request: DaemonRequest } | { ok: false; response: DaemonErrorResponse } {
  const base = z.object({
    id: z.string().min(1).max(128).catch("unknown"),
    v: z.unknown(),
    command: z.unknown(),
    args: z.unknown().optional(),
  }).safeParse(raw);

  if (!base.success) {
    return { ok: false, response: formatDaemonError("unknown", "invalid_request") };
  }
  if (base.data.v !== DAEMON_IPC_VERSION) {
    return {
      ok: false,
      response: formatDaemonError(base.data.id, "unsupported_version"),
    };
  }

  const parsed = DaemonRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: formatDaemonError(base.data.id, "invalid_request") };
  }
  if (!ALLOWED_DAEMON_COMMANDS.has(parsed.data.command)) {
    return {
      ok: false,
      response: formatDaemonError(parsed.data.id, "unknown_command"),
    };
  }
  return { ok: true, request: parsed.data };
}
