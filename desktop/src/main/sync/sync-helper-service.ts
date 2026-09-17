import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { basename } from "node:path";
import { hostname } from "node:os";
import { z } from "zod/v4";
import {
  BackupStatusSchema,
  DesktopSyncMappingSetupRequestSchema,
  DesktopSyncSnapshotSchema,
  SyncMappingConfigSchema,
  type BackupStatus,
  type DesktopSyncSnapshot,
} from "@matrix-os/contracts";
import type { AuthService } from "../auth/auth-service";
import type { InstalledSyncHelper } from "./sync-helper-installer";

const COMMAND_TIMEOUT_MS = 20_000;
const MAX_COMMAND_OUTPUT_BYTES = 512 * 1024;
const MAX_COMMAND_INPUT_BYTES = 32 * 1024;
const MAX_FOLDER_SELECTIONS = 16;
const FOLDER_SELECTION_TTL_MS = 10 * 60_000;

const CliEnvelopeSchema = z.object({
  v: z.literal(1),
  ok: z.literal(true),
  data: z.record(z.string(), z.unknown()),
}).strip();

const DaemonStatusSchema = z.object({
  running: z.boolean(),
  service: z.literal("running").optional(),
  auth: z.enum(["ready", "needs_sign_in", "signed_out"]).optional(),
  connection: z.enum(["connecting", "online", "offline"]).optional(),
  status: z.enum(["paused", "offline", "syncing", "synced", "conflict"]).optional(),
  enabled: z.boolean().optional(),
  paused: z.boolean().optional(),
  activeTransferCount: z.int().nonnegative().optional(),
  conflictCount: z.int().nonnegative().optional(),
  lastSyncAt: z.number().nonnegative().optional(),
  profile: z.string().max(31).optional(),
  mappings: z.array(z.object({
    mappingId: z.uuid(),
    state: z.enum(["paused", "idle", "conflict", "error"]),
    fileCount: z.int().nonnegative(),
    conflictCount: z.int().nonnegative(),
    lastSuccessfulReconcileAt: z.number().nonnegative().nullable(),
    lastIssue: z.enum(["permission", "disk_full", "oversized", "network", "unknown"]).nullable().optional(),
  }).strip()).max(32).optional(),
}).strip();

export type SyncHelperCommandRunner = (
  helper: InstalledSyncHelper,
  args: string[],
  input?: string,
) => Promise<unknown>;

export interface SyncHelperAuth {
  getToken(): string | null;
  getGatewayOrigin(): string;
  getStatus(): ReturnType<AuthService["getStatus"]>;
}

export interface SyncHelperServiceDependencies {
  auth: SyncHelperAuth;
  installHelper: () => Promise<InstalledSyncHelper>;
  verifyHelper: (helper: InstalledSyncHelper) => Promise<void>;
  run: SyncHelperCommandRunner;
  chooseDirectory: (suggestedName?: string) => Promise<string | null>;
  fetchBackupStatus: () => Promise<BackupStatus | null>;
  randomId?: () => string;
  now?: () => number;
  deviceName?: () => string;
}

export interface SyncHelperService {
  getSnapshot(): Promise<DesktopSyncSnapshot>;
  reauthorize(): Promise<DesktopSyncSnapshot>;
  chooseFolder(suggestedName?: string): Promise<{ selectionId: string; displayPath: string } | null>;
  enable(request: z.infer<typeof DesktopSyncMappingSetupRequestSchema>): Promise<DesktopSyncSnapshot>;
  addMapping(request: z.infer<typeof DesktopSyncMappingSetupRequestSchema>): Promise<DesktopSyncSnapshot>;
  pauseMapping(mappingId: string): Promise<DesktopSyncSnapshot>;
  resumeMapping(mappingId: string): Promise<DesktopSyncSnapshot>;
  removeMapping(mappingId: string): Promise<DesktopSyncSnapshot>;
  rescan(mappingId?: string): Promise<DesktopSyncSnapshot>;
  setEnabled(enabled: boolean): Promise<DesktopSyncSnapshot>;
  revokeDesktopGrant(): Promise<void>;
}

function safeCapability(err: unknown): DesktopSyncSnapshot["capability"] {
  const code = err instanceof Error && "code" in err ? String(err.code) : "";
  if (code === "sync_helper_platform_unsupported") return "unsupported_platform";
  if (code.includes("incompatible")) return "helper_incompatible";
  if (code.includes("invalid") || code.includes("digest") || code.includes("unsafe")) {
    return "helper_invalid";
  }
  return "helper_missing";
}

function emptySnapshot(
  capability: DesktopSyncSnapshot["capability"],
  backup: BackupStatus | null,
  backupState: DesktopSyncSnapshot["backupState"],
): DesktopSyncSnapshot {
  return DesktopSyncSnapshotSchema.parse({
    schemaVersion: 1,
    capability,
    helperVersion: null,
    service: "not_configured",
    profile: null,
    runtimeSlot: null,
    enabled: false,
    paused: false,
    auth: "unknown",
    connection: "unknown",
    status: "unavailable",
    activeTransferCount: 0,
    conflictCount: 0,
    lastSyncAt: null,
    mappings: [],
    backup,
    backupState,
  });
}

async function readBackup(
  deps: SyncHelperServiceDependencies,
): Promise<{ backup: BackupStatus | null; state: DesktopSyncSnapshot["backupState"] }> {
  if (!deps.auth.getToken()) return { backup: null, state: "unknown" };
  try {
    const backup = await deps.fetchBackupStatus();
    return backup
      ? { backup: BackupStatusSchema.parse(backup), state: "available" }
      : { backup: null, state: "unavailable" };
  } catch {
    return { backup: null, state: "offline" };
  }
}

export function createSyncHelperService(
  deps: SyncHelperServiceDependencies,
): SyncHelperService {
  const selections = new Map<string, { path: string; expiresAt: number }>();
  const now = deps.now ?? Date.now;
  const randomId = deps.randomId ?? randomUUID;

  const evictSelections = () => {
    const current = now();
    for (const [id, selection] of selections) {
      if (selection.expiresAt <= current) selections.delete(id);
    }
    while (selections.size >= MAX_FOLDER_SELECTIONS) {
      const oldest = selections.keys().next().value as string | undefined;
      if (!oldest) break;
      selections.delete(oldest);
    }
  };

  const consumeSelection = (selectionId: string): string => {
    evictSelections();
    const selection = selections.get(selectionId);
    selections.delete(selectionId);
    if (!selection || selection.expiresAt <= now()) throw new Error("sync_folder_selection_expired");
    return selection.path;
  };

  const helper = async (): Promise<InstalledSyncHelper> => {
    const installed = await deps.installHelper();
    await deps.verifyHelper(installed);
    return installed;
  };

  const runCli = async (args: string[]): Promise<Record<string, unknown>> => {
    const output = CliEnvelopeSchema.parse(await deps.run(await helper(), args));
    return output.data;
  };

  const getSnapshot = async (): Promise<DesktopSyncSnapshot> => {
    const backupResult = await readBackup(deps);
    let installed: InstalledSyncHelper;
    try {
      installed = await helper();
    } catch (err: unknown) {
      return emptySnapshot(safeCapability(err), backupResult.backup, backupResult.state);
    }

    let daemon: z.infer<typeof DaemonStatusSchema>;
    try {
      const envelope = CliEnvelopeSchema.parse(
        await deps.run(installed, ["sync", "status", "--json", "--profile", "desktop"]),
      );
      daemon = DaemonStatusSchema.parse(envelope.data);
    } catch {
      daemon = { running: false };
    }
    const authStatus = deps.auth.getStatus();
    if (!daemon.running) {
      let config: z.infer<typeof SyncMappingConfigSchema> | null = null;
      try {
        const list = await runCli(["sync", "list", "--json", "--profile", "desktop"]);
        config = SyncMappingConfigSchema.parse(list.config);
      } catch {
        // A missing profile is distinct from an unavailable helper. Preserve
        // the stopped state while enrollment remains the recovery action.
      }
      const mappings = (config?.mappings ?? []).map((mapping) => ({
        ...mapping,
        state: "offline" as const,
        fileCount: 0,
        conflictCount: 0,
        lastSuccessfulReconcileAt: null,
      }));
      return DesktopSyncSnapshotSchema.parse({
        ...emptySnapshot("available", backupResult.backup, backupResult.state),
        helperVersion: installed.cliVersion,
        service: "stopped",
        profile: config?.profile ?? null,
        runtimeSlot: config?.runtimeSlot ?? authStatus.runtimeSlot,
        enabled: config?.enabled ?? false,
        paused: config ? !config.enabled : false,
        auth: authStatus.signedIn ? "unknown" : "signed_out",
        connection: "offline",
        status: "offline",
        mappings,
      });
    }

    const list = await runCli(["sync", "list", "--json", "--profile", "desktop"]);
    const config = SyncMappingConfigSchema.parse(list.config);
    const statuses = new Map((daemon.mappings ?? []).map((status) => [status.mappingId, status]));
    const mappings = config.mappings.map((mapping) => {
      const status = statuses.get(mapping.id);
      return {
        ...mapping,
        state: daemon.connection === "offline"
          ? "offline" as const
          : status?.state ?? (mapping.enabled ? "idle" as const : "paused" as const),
        fileCount: status?.fileCount ?? 0,
        conflictCount: status?.conflictCount ?? 0,
        lastSuccessfulReconcileAt: status?.lastSuccessfulReconcileAt ?? null,
        lastIssue: status?.lastIssue ?? null,
      };
    });
    return DesktopSyncSnapshotSchema.parse({
      schemaVersion: 1,
      capability: "available",
      helperVersion: installed.cliVersion,
      service: "running",
      profile: config.profile,
      runtimeSlot: config.runtimeSlot,
      enabled: config.enabled,
      paused: daemon.paused ?? !config.enabled,
      auth: daemon.auth ?? (authStatus.signedIn ? "ready" : "signed_out"),
      connection: daemon.connection ?? "unknown",
      status: daemon.status ?? "offline",
      activeTransferCount: daemon.activeTransferCount ?? 0,
      conflictCount: daemon.conflictCount ?? mappings.reduce((sum, value) => sum + value.conflictCount, 0),
      lastSyncAt: daemon.lastSyncAt || null,
      mappings,
      backup: backupResult.backup,
      backupState: backupResult.state,
    });
  };

  const mutate = async (args: string[]): Promise<DesktopSyncSnapshot> => {
    await runCli([...args, "--json", "--profile", "desktop"]);
    return getSnapshot();
  };

  return {
    getSnapshot,

    async reauthorize() {
      const token = deps.auth.getToken();
      const status = deps.auth.getStatus();
      if (!token || !status.signedIn) throw new Error("sync_sign_in_required");
      await deps.run(await helper(), ["__desktop-reauthorize"], JSON.stringify({
        schemaVersion: 1,
        profile: "desktop",
        platformUrl: status.platformHost,
        desktopAccessToken: token,
        deviceName: (deps.deviceName ?? hostname)(),
        expectedIdentity: {
          userId: status.userId,
          handle: status.handle,
          runtimeSlot: status.runtimeSlot,
        },
      }));
      return getSnapshot();
    },

    async chooseFolder(suggestedName) {
      const selected = await deps.chooseDirectory(suggestedName);
      if (!selected) return null;
      const info = await lstat(selected);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("sync_folder_selection_invalid");
      if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error("sync_folder_selection_invalid");
      }
      evictSelections();
      const selectionId = randomId();
      selections.set(selectionId, { path: selected, expiresAt: now() + FOLDER_SELECTION_TTL_MS });
      return { selectionId, displayPath: selected };
    },

    async enable(rawRequest) {
      const request = DesktopSyncMappingSetupRequestSchema.parse(rawRequest);
      const token = deps.auth.getToken();
      const status = deps.auth.getStatus();
      if (!token || !status.signedIn) throw new Error("sync_sign_in_required");
      const localRoot = consumeSelection(request.selectionId);
      const enrollmentInput = JSON.stringify({
        schemaVersion: 1,
        profile: "desktop",
        platformUrl: status.platformHost,
        gatewayUrl: deps.auth.getGatewayOrigin(),
        desktopAccessToken: token,
        deviceName: (deps.deviceName ?? hostname)(),
        localRoot,
        ...(request.label ? { label: request.label } : {}),
        remotePrefix: request.remotePrefix,
        direction: request.direction,
        propagateDeletes: request.propagateDeletes,
        excludes: request.excludes,
        expectedIdentity: {
          userId: status.userId,
          handle: status.handle,
          runtimeSlot: status.runtimeSlot,
        },
      });
      await deps.run(await helper(), ["__desktop-enroll"], enrollmentInput);
      return getSnapshot();
    },

    async addMapping(rawRequest) {
      const request = DesktopSyncMappingSetupRequestSchema.parse(rawRequest);
      const localRoot = consumeSelection(request.selectionId);
      const label = request.label ?? (
        (request.remotePrefix ? basename(request.remotePrefix) : basename(localRoot))
        || "Synced folder"
      );
      return mutate([
        "sync", "add",
        "--path", localRoot,
        "--folder", request.remotePrefix,
        "--direction", request.direction,
        "--label", label,
        ...(request.excludes.length > 0 ? ["--exclude", request.excludes.join(",")] : []),
        ...(request.propagateDeletes ? ["--propagateDeletes"] : []),
        ...(request.parentMappingId ? ["--excludeParent", request.parentMappingId] : []),
      ]);
    },

    pauseMapping: (mappingId) => mutate(["sync", "pause", "--mapping", mappingId]),
    resumeMapping: (mappingId) => mutate(["sync", "resume", "--mapping", mappingId]),
    removeMapping: (mappingId) => mutate(["sync", "remove", "--mapping", mappingId]),
    rescan: (mappingId) => mutate([
      "sync", "rescan",
      ...(mappingId ? ["--mapping", mappingId] : []),
    ]),
    setEnabled: (enabled) => mutate(["sync", enabled ? "resume" : "pause"]),
    async revokeDesktopGrant() {
      try {
        await deps.run(await helper(), ["__desktop-revoke"]);
      } catch {
        // Sign-out still clears the Desktop session. The helper keeps sync
        // paused/needs-sign-in and never receives that session credential.
      }
    },
  };
}

export function runSyncHelperCommand(
  verify: (helper: InstalledSyncHelper) => Promise<void>,
): SyncHelperCommandRunner {
  return async (helper, args, input) => {
    await verify(helper);
    if (input && Buffer.byteLength(input, "utf8") > MAX_COMMAND_INPUT_BYTES) {
      throw new Error("sync_helper_input_too_large");
    }
    return new Promise((resolve, reject) => {
      const child = spawn(helper.executable, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          HOME: process.env.HOME,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: process.env.LANG ?? "C.UTF-8",
        },
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        operation();
      };
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString("utf8");
        if (Buffer.byteLength(next, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
          child.kill("SIGKILL");
          finish(() => reject(new Error("sync_helper_output_too_large")));
        }
        return next;
      };
      child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
      child.on("error", () => finish(() => reject(new Error("sync_helper_unavailable"))));
      child.on("exit", (code) => finish(() => {
        if (code !== 0) {
          reject(new Error("sync_helper_command_failed"));
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          reject(new Error("sync_helper_response_invalid"));
        }
      }));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(() => reject(new Error("sync_helper_timeout")));
      }, COMMAND_TIMEOUT_MS);
      child.stdin.end(input);
    });
  };
}

export async function fetchDesktopBackupStatus(auth: SyncHelperAuth): Promise<BackupStatus | null> {
  const token = auth.getToken();
  if (!token) return null;
  const response = await fetch(new URL("/api/sync/backup-status", auth.getGatewayOrigin()), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !response.body) return null;
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > 32 * 1024) throw new Error("backup_status_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > 32 * 1024) {
      await reader.cancel();
      throw new Error("backup_status_invalid");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return BackupStatusSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
}
