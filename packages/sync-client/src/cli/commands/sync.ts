import { defineCommand } from "citty";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig, saveConfig, defaultSyncPath, generatePeerId } from "../../lib/config.js";
import {
  isDaemonClientError,
  sendCommand,
  isDaemonRunning,
} from "../daemon-client.js";
import { installService, startService } from "../../daemon/service.js";
import { resolveCliProfile } from "../profiles.js";
import { formatCliError, formatCliSuccess } from "../output.js";

const SUBCOMMANDS = new Set(["status", "pause", "resume"]);

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

async function runStart(
  rawPath: string | undefined,
  folder: string | undefined,
  args: Record<string, unknown>,
): Promise<void> {
  const syncPath = rawPath ? resolve(rawPath) : defaultSyncPath();
  await mkdir(syncPath, { recursive: true });

  const previous = await loadConfig();
  const profile = await resolveCliProfile(args);
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
  await saveConfig(config);

  // Skip the launchctl unload/load bounce if the daemon is already running
  // and neither the sync path nor the gateway folder changed. Bouncing for
  // no reason creates a race where `matrix sync status` immediately after
  // returns "not running" while the socket is being recreated.
  const sameTarget =
    previous?.syncPath === syncPath &&
    (previous?.gatewayFolder ?? "") === gatewayFolder;
  if (sameTarget && (await isDaemonRunning())) {
    console.log(`Sync already running for: ${syncPath}`);
    console.log(`Peer ID: ${config.peerId}`);
    if (gatewayFolder) console.log(`Gateway folder: ${gatewayFolder}`);
    return;
  }

  // Point launchd/systemd at the .mjs launcher -- it re-execs node with
  // --import tsx so the .ts daemon entry can be loaded directly. Plain node
  // can't import .ts files.
  const daemonPath = new URL("../../daemon/launcher.mjs", import.meta.url).pathname;
  await installService(daemonPath);
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
  },
  run: async ({ args, rawArgs }) => {
    const first = rawArgs?.find((a) => !a.startsWith("-"));
    const json = args.json === true;

    if (first && SUBCOMMANDS.has(first)) {
      try {
        switch (first) {
          case "status":
            return runStatus(json);
          case "pause":
            await sendCommand("pause");
            console.log(json ? formatCliSuccess({ paused: true }) : "Sync paused.");
            return;
          case "resume":
            await sendCommand("resume");
            console.log(json ? formatCliSuccess({ resumed: true }) : "Sync resumed.");
            return;
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
