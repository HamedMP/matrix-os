import { defineCommand } from "citty";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig, saveConfig, defaultSyncPath, generatePeerId } from "../../lib/config.js";
import { sendCommand, isDaemonRunning } from "../daemon-client.js";
import { installService, startService } from "../../daemon/service.js";

const SUBCOMMANDS = new Set(["status", "pause", "resume"]);

async function runStatus(): Promise<void> {
  const running = await isDaemonRunning();
  if (!running) {
    console.log("Sync daemon is not running.");
    return;
  }
  const status = await sendCommand("status");
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
): Promise<void> {
  const syncPath = rawPath ? resolve(rawPath) : defaultSyncPath();
  await mkdir(syncPath, { recursive: true });

  const previous = await loadConfig();
  const gatewayFolder = folder ?? previous?.gatewayFolder ?? "";
  const config = previous
    ? { ...previous, syncPath, gatewayFolder }
    : {
        gatewayUrl: "https://matrix-os.com",
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

    if (first && SUBCOMMANDS.has(first)) {
      switch (first) {
        case "status":
          return runStatus();
        case "pause":
          await sendCommand("pause");
          console.log("Sync paused.");
          return;
        case "resume":
          await sendCommand("resume");
          console.log("Sync resumed.");
          return;
      }
    }

    // Positional path: prefer rawArgs[0] if not a flag, else --path.
    const path = first ?? (typeof args.path === "string" ? args.path : undefined);
    const folder = typeof args.folder === "string" ? args.folder : undefined;
    await runStart(path, folder);
  },
});
