import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { migrateTerminalWorkspaces, rollbackTerminalWorkspaceMigration } from "./migration.js";
import { initializeMatrixZellijConfig } from "./zellij-bootstrap.js";
import { TerminalRuntime } from "./runtime.js";
import { TerminalRuntimeSocketClient } from "./socket-client.js";
import { TerminalRuntimeSocketServer } from "./socket-server.js";
import { TerminalWorkspaceStore } from "./workspace-store.js";
import { ZellijCliRuntimeAdapter } from "./zellij-adapter.js";
import { resolveTerminalRuntimeLimits } from "./runtime-config.js";
import { startTerminalOrphanSweepLifecycle } from "./orphan-sweep-lifecycle.js";
import { runBestEffortTerminalShutdown } from "./service-shutdown.js";
import {
  createUserSystemdTerminalRuntime,
  loadInstalledTerminalRuntimeGeneration,
} from "./user-systemd-controller.js";
import { createUserSystemdWorkspaceLifecycle } from "./user-systemd-workspace.js";
import { createTerminalCapacityAdmission } from "./user-systemd-capacity.js";
import {
  assertIsolatedTerminalGeneration,
  assertIsolatedTerminalPlacement,
  resolveTerminalRuntimeDeployment,
} from "./runtime-deployment.js";
import {
  assertTerminalRuntimeDirectory,
  createTerminalRuntimeEnvironment,
} from "./runtime-environment.js";

const ProjectConfigSchema = z.object({
  id: z.string().min(1).max(160),
  localPath: z.string().min(1).max(4096),
}).passthrough();
const MAX_PROJECT_CONFIG_BYTES = 1024 * 1024;

async function listProjects(homePath: string): Promise<Array<{ id: string; cwd: string }>> {
  const directory = join(homePath, "projects");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const projects: Array<{ id: string; cwd: string }> = [];
  for (const entry of entries.slice(0, 10_000)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name, "config.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_PROJECT_CONFIG_BYTES) continue;
      const project = ProjectConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
      projects.push({ id: project.id, cwd: project.localPath });
    } catch (error) {
      console.error("[terminal-runtime] project metadata skipped", error);
    }
  }
  return projects;
}

async function main(): Promise<void> {
  const deployment = resolveTerminalRuntimeDeployment(process.env);
  const { homePath, socketPath, appDir, terminalRuntimeRoot, generationLockHelperPath } = deployment;
  const mode = process.argv[2];
  if (mode === "--health-check") {
    const client = new TerminalRuntimeSocketClient({ socketPath, timeoutMs: 5_000 });
    await client.listWorkspaces();
    return;
  }
  const uid = process.getuid?.();
  if (uid == null) throw new Error("terminal_runtime_uid_unavailable");
  const isolatedProfile = deployment.mode === "isolated" ? deployment.profile : undefined;
  const runtimeEnvironment = deployment.mode === "isolated"
    ? deployment.environment : createTerminalRuntimeEnvironment({ homePath, uid });
  await assertTerminalRuntimeDirectory(runtimeEnvironment.XDG_RUNTIME_DIR!, uid);
  if (isolatedProfile) await assertIsolatedTerminalPlacement(isolatedProfile, runtimeEnvironment, uid);
  const generation = await loadInstalledTerminalRuntimeGeneration(appDir, {
    terminalRuntimeRoot,
    userUnitRoot: isolatedProfile?.userUnitRoot,
  });
  if (isolatedProfile) await assertIsolatedTerminalGeneration(isolatedProfile, generation);
  const controller = createUserSystemdTerminalRuntime({
    homePath,
    uid,
    env: runtimeEnvironment,
    generation,
    terminalRuntimeRoot,
    generationLockHelperPath,
    capacityAdmission: isolatedProfile && createTerminalCapacityAdmission({ root: isolatedProfile.cgroupRoot }),
  });
  if (!isolatedProfile) await controller.assertInstallationReady();
  const zellij = new ZellijCliRuntimeAdapter({
    homePath,
    env: runtimeEnvironment,
    binaryPath: join(terminalRuntimeRoot, "generations", generation, "zellij"),
    workspaceLifecycle: createUserSystemdWorkspaceLifecycle({
      homePath,
      controller,
      terminalRuntimeRoot,
    }),
  });
  if (mode === "--rollback") {
    await rollbackTerminalWorkspaceMigration({ homePath, cutover: zellij });
    return;
  }
  // Migration starts Zellij in ExecStartPre, before the gateway can initialize it.
  await initializeMatrixZellijConfig(homePath);
  await migrateTerminalWorkspaces({ homePath, projects: await listProjects(homePath), cutover: zellij });
  if (mode === "--migrate-only") return;

  const runtime = new TerminalRuntime({
    store: new TerminalWorkspaceStore({ homePath }),
    zellij,
    ...resolveTerminalRuntimeLimits(isolatedProfile ? runtimeEnvironment : process.env),
  });
  await runtime.restoreAll();
  const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
  await server.start();
  const orphanSweep = startTerminalOrphanSweepLifecycle({
    intervalMs: 15 * 60 * 1_000,
    sweep: () => controller.sweepOrphanedSessions(),
    logCompleted: (result) => {
      console.info("[terminal-runtime]", {
        event: "terminal.runtime.orphan.sweep.completed",
        ...result,
      });
    },
    logFailed: (error) => {
      console.warn(
        "[terminal-runtime] orphan sweep failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    },
  });
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await orphanSweep.close();
    await runBestEffortTerminalShutdown(() => runtime.shutdown());
  };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
}

void main().catch((error: unknown) => {
  console.error("[terminal-runtime] fatal startup failure", error);
  process.exit(1);
});
