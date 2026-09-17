import { defineCommand } from "citty";
import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  SyncMappingConfigSchema,
  SyncMappingSchema,
  type SyncDirection,
  type SyncMappingConfig,
} from "@matrix-os/contracts";
import {
  defaultSyncPath,
  generatePeerId,
  getConfigDir,
  type SyncConfig,
} from "../../lib/config.js";
import {
  loadProfileSyncConfig,
  saveProfileSyncConfig,
} from "../../lib/profile-sync-config.js";
import {
  isDaemonClientError,
  sendCommand,
  isDaemonRunning,
} from "../daemon-client.js";
import {
  createSourceDaemonServiceCommand,
  createStandaloneDaemonServiceCommand,
  installService,
  startService,
} from "../../daemon/service.js";
import { resolveCliProfile } from "../profiles.js";
import { isStandaloneRuntime } from "../standalone-runtime.js";
import { formatCliError, formatCliSuccess } from "../output.js";
import { loadProfileAuth } from "../../auth/token-store.js";
import { loadSyncMappingConfig } from "../../lib/sync-mapping-config.js";

const SUBCOMMANDS = new Set([
  "status",
  "pause",
  "resume",
  "list",
  "add",
  "remove",
  "conflicts",
  "rescan",
]);
type SyncDaemonRuntime = NonNullable<SyncConfig["syncDaemonRuntime"]>;

function currentSyncDaemonRuntime(): SyncDaemonRuntime {
  return isStandaloneRuntime() ? "standalone" : "source";
}

export function shouldReuseRunningSyncService({
  previous,
  syncPath,
  gatewayFolder,
  currentRuntime,
}: {
  previous: SyncConfig | null;
  syncPath: string;
  gatewayFolder: string;
  currentRuntime: SyncDaemonRuntime;
}): boolean {
  const sameTarget =
    previous?.syncPath === syncPath &&
    (previous?.gatewayFolder ?? "") === gatewayFolder;
  if (!sameTarget) return false;

  // Configs written before standalone binaries existed did not record a daemon
  // runtime. Those are source/npm services, so a standalone install must force
  // one service rewrite instead of reusing the old launcher.
  const previousRuntime = previous?.syncDaemonRuntime ?? "source";
  return previousRuntime === currentRuntime;
}

function writeSyncError(err: unknown, json: boolean): void {
  const code = isDaemonClientError(err) ? err.code : "sync_failed";
  const message = isDaemonClientError(err) ? err.message : "Sync command failed.";
  console.error(json ? formatCliError(code, message) : `Error: ${message}`);
  process.exitCode = 1;
}

async function runStatus(json: boolean): Promise<void> {
  const running = await isDaemonRunning();
  if (!running) {
    if (json) {
      console.log(formatCliSuccess({ running: false }));
      return;
    }
    console.log("Sync daemon is not running.");
    return;
  }
  const status = await sendCommand("status");
  if (json) {
    console.log(formatCliSuccess({ ...status, running: true }));
    return;
  }
  console.log("Sync status:");
  console.log(`  Syncing: ${status.syncing ? "yes" : "paused"}`);
  console.log(`  Manifest version: ${status.manifestVersion}`);
  console.log(`  Files tracked: ${status.fileCount}`);
  if (typeof status.lastSyncAt === "number" && status.lastSyncAt > 0) {
    console.log(`  Last sync: ${new Date(status.lastSyncAt).toISOString()}`);
  }
}

function requireMappingId(value: unknown): string {
  const parsed = SyncMappingSchema.shape.id.safeParse(value);
  if (!parsed.success) throw new Error("A valid --mapping UUID is required.");
  return parsed.data;
}

async function loadMappingConfig(): Promise<SyncMappingConfig> {
  const response = await sendCommand("sync.mappings.list");
  const parsed = SyncMappingConfigSchema.safeParse(response.config);
  if (!parsed.success) throw new Error("The sync daemon returned an invalid mapping configuration.");
  return parsed.data;
}

async function loadStoredMappingConfig(
  args: Record<string, unknown>,
): Promise<SyncMappingConfig> {
  const profile = await resolveCliProfile(args);
  const auth = await loadProfileAuth(profile.name);
  if (!auth) throw new Error("No stored sync identity is available for this profile.");
  const config = await loadSyncMappingConfig({
    configDir: getConfigDir(),
    profile: profile.name,
    scope: {
      ownerId: auth.userId,
      runtimeSlot: auth.runtimeSlot ?? "primary",
    },
  });
  if (!config) throw new Error("No synced folders are configured for this profile.");
  return config;
}

async function loadReadableMappingConfig(
  args: Record<string, unknown>,
): Promise<SyncMappingConfig> {
  return (await isDaemonRunning())
    ? loadMappingConfig()
    : loadStoredMappingConfig(args);
}

function printMappingConfig(config: SyncMappingConfig, json: boolean): void {
  if (json) {
    console.log(formatCliSuccess({ config }));
    return;
  }
  if (config.mappings.length === 0) {
    console.log("No synced folders configured.");
    return;
  }
  for (const mapping of config.mappings) {
    console.log(`${mapping.id}  ${mapping.enabled ? "active" : "paused"}  ${mapping.direction}`);
    console.log(`  ${mapping.localRoot} <-> /${mapping.remotePrefix}`);
  }
}

async function runMappingMutation(
  command: "pause" | "resume" | "remove",
  args: Record<string, unknown>,
  json: boolean,
): Promise<void> {
  const config = await loadMappingConfig();
  const mappingId = requireMappingId(args.mapping);
  const result = await sendCommand(`sync.mappings.${command}`, {
    expectedRevision: config.revision,
    mappingId,
  });
  if (json) {
    console.log(formatCliSuccess(result));
    return;
  }
  console.log(`Sync mapping ${command === "remove" ? "removed" : `${command}d`}: ${mappingId}`);
}

async function runAdd(args: Record<string, unknown>, json: boolean): Promise<void> {
  const localRoot = resolve(
    typeof args.path === "string" && args.path.trim() ? args.path : ".",
  );
  await mkdir(localRoot, { recursive: true });
  const remotePrefix = typeof args.folder === "string"
    ? args.folder.replace(/^\/+|\/+$/g, "")
    : "";
  const direction = (typeof args.direction === "string" ? args.direction : "two_way") as SyncDirection;
  const excludes = typeof args.exclude === "string"
    ? args.exclude.split(",").map((entry) => entry.trim()).filter(Boolean)
    : [];
  const mapping = SyncMappingSchema.parse({
    id: randomUUID(),
    label: typeof args.label === "string" && args.label.trim()
      ? args.label.trim()
      : remotePrefix || basename(localRoot) || "Matrix Home",
    localRoot,
    remotePrefix,
    direction,
    enabled: true,
    propagateDeletes: args.propagateDeletes === true,
    excludes,
  });
  const config = await loadMappingConfig();
  const result = await sendCommand("sync.mappings.add", {
    expectedRevision: config.revision,
    mapping,
    ...(typeof args.excludeParent === "string"
      ? { parentMappingId: requireMappingId(args.excludeParent) }
      : {}),
  });
  if (json) {
    console.log(formatCliSuccess(result));
    return;
  }
  console.log(`Sync mapping added: ${mapping.id}`);
  console.log(`  ${mapping.localRoot} <-> /${mapping.remotePrefix}`);
}

async function runMappingSubcommand(
  command: string,
  args: Record<string, unknown>,
  json: boolean,
): Promise<void> {
  switch (command) {
    case "list":
      printMappingConfig(await loadReadableMappingConfig(args), json);
      return;
    case "add":
      await runAdd(args, json);
      return;
    case "pause":
    case "resume":
    case "remove":
      if (args.mapping !== undefined) {
        await runMappingMutation(command, args, json);
        return;
      }
      await sendCommand(command);
      console.log(json
        ? formatCliSuccess(command === "pause" ? { paused: true } : { resumed: true })
        : `Sync ${command === "pause" ? "paused" : "resumed"}.`);
      return;
    case "conflicts": {
      const mappingId = args.mapping === undefined ? undefined : requireMappingId(args.mapping);
      const result = await sendCommand("sync.mappings.conflicts", { mappingId });
      if (json) console.log(formatCliSuccess(result));
      else {
        const conflicts = Array.isArray(result.conflicts) ? result.conflicts : [];
        console.log(conflicts.length === 0 ? "No unresolved sync conflicts." : JSON.stringify(conflicts, null, 2));
      }
      return;
    }
    case "rescan": {
      const mappingId = args.mapping === undefined ? undefined : requireMappingId(args.mapping);
      const result = await sendCommand("sync.mappings.rescan", { mappingId });
      console.log(json ? formatCliSuccess(result) : "Sync rescan requested.");
      return;
    }
  }
}

async function runStart(
  rawPath: string | undefined,
  folder: string | undefined,
  args: Record<string, unknown>,
): Promise<void> {
  const syncPath = rawPath ? resolve(rawPath) : defaultSyncPath();
  await mkdir(syncPath, { recursive: true });

  const profile = await resolveCliProfile(args);
  const previous = (await loadProfileSyncConfig({ profileName: profile.name }))?.config ?? null;
  const currentRuntime = currentSyncDaemonRuntime();
  const gatewayFolder = folder ?? previous?.gatewayFolder ?? "";
  const config = previous
    ? {
        ...previous,
        platformUrl: profile.platformUrl,
        gatewayUrl: profile.gatewayUrl,
        profile: profile.name,
        syncPath,
        gatewayFolder,
      }
    : {
        profile: profile.name,
        platformUrl: profile.platformUrl,
        gatewayUrl: profile.gatewayUrl,
        syncPath,
        gatewayFolder,
        peerId: generatePeerId(),
        pauseSync: false,
      };
  const serviceCommand = currentRuntime === "standalone"
    ? createStandaloneDaemonServiceCommand()
    : createSourceDaemonServiceCommand(new URL("../../daemon/launcher.mjs", import.meta.url).pathname);

  // Skip the launchctl unload/load bounce if the daemon is already running
  // and neither the sync target nor the daemon launcher runtime changed.
  // Bouncing for no reason creates a race where `matrix sync status`
  // immediately after returns "not running" while the socket is being
  // recreated.
  if (
    (await isDaemonRunning()) &&
    shouldReuseRunningSyncService({
      previous,
      syncPath,
      gatewayFolder,
      currentRuntime,
    })
  ) {
    await saveProfileSyncConfig({ ...config, syncDaemonRuntime: currentRuntime });
    console.log(`Sync already running for: ${syncPath}`);
    console.log(`Peer ID: ${config.peerId}`);
    if (gatewayFolder) console.log(`Gateway folder: ${gatewayFolder}`);
    return;
  }

  await installService(serviceCommand);
  const installedConfig = { ...config, syncDaemonRuntime: currentRuntime };
  await saveProfileSyncConfig(installedConfig);
  await startService();

  console.log(`Sync started for: ${syncPath}`);
  console.log(`Peer ID: ${config.peerId}`);
  if (gatewayFolder) {
    console.log(`Gateway folder: ${gatewayFolder}`);
  } else {
    console.log(`Gateway folder: <full mirror>`);
  }
}

// Citty's subCommands feature rejects unknown first-positional args before
// the parent's `run` fires, which conflicts with our "first positional is
// the sync path" UX (e.g. `matrix sync ~/foo`). Inspect rawArgs ourselves
// so paths and the status/pause/resume verbs both work.
export const syncCommand = defineCommand({
  meta: {
    name: "sync",
    description: "Manage file sync. Usage: matrixos sync [<path>|status|pause|resume]",
  },
  args: {
    profile: {
      type: "string",
      description: "Profile to use for gateway configuration",
      required: false,
    },
    dev: {
      type: "boolean",
      description: "Use the local profile",
      required: false,
      default: false,
    },
    platform: {
      type: "string",
      description: "Override platform URL for this command",
      required: false,
    },
    gateway: {
      type: "string",
      description: "Override gateway URL for this command",
      required: false,
    },
    token: {
      type: "string",
      description: "Override bearer token for this command",
      required: false,
    },
    json: {
      type: "boolean",
      description: "Emit machine-readable JSON output",
      required: false,
      default: false,
    },
    path: {
      type: "string",
      alias: "p",
      description: "Local folder to sync (default: ~/matrixos/)",
      required: false,
    },
    folder: {
      type: "string",
      alias: "f",
      description:
        "Gateway subtree to scope sync to. Default: \"\" (full mirror of the user's sync root).",
      required: false,
    },
    mapping: {
      type: "string",
      alias: "m",
      description: "Mapping UUID for pause, resume, remove, conflicts, or rescan",
      required: false,
    },
    direction: {
      type: "string",
      description: "Mapping direction: two_way, to_matrix, or to_local",
      required: false,
    },
    label: {
      type: "string",
      description: "Human-readable mapping label",
      required: false,
    },
    exclude: {
      type: "string",
      description: "Comma-separated relative subtree exclusions",
      required: false,
    },
    propagateDeletes: {
      type: "boolean",
      description: "Propagate confirmed tracked deletions (off by default)",
      required: false,
      default: false,
    },
    excludeParent: {
      type: "string",
      description: "Parent mapping UUID to exclude atomically during add",
      required: false,
    },
  },
  run: async ({ args, rawArgs }) => {
    const first = rawArgs?.find((a) => !a.startsWith("-"));
    const json = args.json === true;

    if (first && SUBCOMMANDS.has(first)) {
      try {
        switch (first) {
          case "status":
            return await runStatus(json);
          default:
            return await runMappingSubcommand(first, args, json);
        }
      } catch (err: unknown) {
        writeSyncError(err, json);
        return;
      }
    }

    // Positional path: prefer rawArgs[0] if not a flag, else --path.
    const path = first ?? (typeof args.path === "string" ? args.path : undefined);
    const folder = typeof args.folder === "string" ? args.folder : undefined;
    await runStart(path, folder, args);
  },
});
