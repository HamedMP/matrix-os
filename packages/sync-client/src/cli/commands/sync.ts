import { defineCommand } from "citty";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadConfig, saveConfig, defaultSyncPath, generatePeerId } from "../../lib/config.js";
import { sendCommand, isDaemonRunning } from "../daemon-client.js";
import { installService, startService, stopService } from "../../daemon/service.js";

const statusCommand = defineCommand({
  meta: { name: "status", description: "Show sync status" },
  run: async () => {
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
  },
});

const pauseCommand = defineCommand({
  meta: { name: "pause", description: "Pause file sync" },
  run: async () => {
    await sendCommand("pause");
    console.log("Sync paused.");
  },
});

const resumeCommand = defineCommand({
  meta: { name: "resume", description: "Resume file sync" },
  run: async () => {
    await sendCommand("resume");
    console.log("Sync resumed.");
  },
});

export const syncCommand = defineCommand({
  meta: { name: "sync", description: "Manage file sync" },
  args: {
    path: {
      type: "positional",
      description: "Local folder to sync (default: ~/matrixos/)",
      required: false,
    },
  },
  subCommands: {
    status: statusCommand,
    pause: pauseCommand,
    resume: resumeCommand,
  },
  run: async ({ args }) => {
    const syncPath = args.path ? resolve(args.path) : defaultSyncPath();
    await mkdir(syncPath, { recursive: true });

    let config = await loadConfig();
    if (!config) {
      config = {
        gatewayUrl: "https://matrix-os.com",
        syncPath,
        peerId: generatePeerId(),
        pauseSync: false,
      };
    } else {
      config.syncPath = syncPath;
    }

    await saveConfig(config);

    const daemonPath = new URL("../../daemon/index.js", import.meta.url).pathname;
    await installService(daemonPath);
    await startService();

    console.log(`Sync started for: ${syncPath}`);
    console.log(`Peer ID: ${config.peerId}`);
  },
});
