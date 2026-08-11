import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod/v4";
import { migrateTerminalWorkspaces, rollbackTerminalWorkspaceMigration } from "./migration.js";
import { TerminalRuntime } from "./runtime.js";
import { TerminalRuntimeSocketClient } from "./socket-client.js";
import { TerminalRuntimeSocketServer } from "./socket-server.js";
import { TerminalWorkspaceStore } from "./workspace-store.js";
import { ZellijCliRuntimeAdapter } from "./zellij-adapter.js";

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
  const homePath = resolve(process.env.MATRIX_HOME ?? process.env.HOME ?? "/home/matrix/home");
  const socketPath = process.env.MATRIX_TERMINAL_RUNTIME_SOCKET ?? "/run/matrix/terminal-runtime.sock";
  const mode = process.argv[2];
  if (mode === "--health-check") {
    const client = new TerminalRuntimeSocketClient({ socketPath, timeoutMs: 5_000 });
    await client.listWorkspaces();
    return;
  }
  const zellij = new ZellijCliRuntimeAdapter({
    homePath,
    binaryPath: process.env.MATRIX_ZELLIJ_BIN ?? "/opt/matrix/bin/zellij",
  });
  if (mode === "--rollback") {
    await rollbackTerminalWorkspaceMigration({ homePath, cutover: zellij });
    return;
  }
  await migrateTerminalWorkspaces({ homePath, projects: await listProjects(homePath), cutover: zellij });
  if (mode === "--migrate-only") return;

  const runtime = new TerminalRuntime({ store: new TerminalWorkspaceStore({ homePath }), zellij });
  await runtime.restoreAll();
  const server = new TerminalRuntimeSocketServer({ socketPath, runtime });
  await server.start();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
    await runtime.shutdown();
  };
  process.once("SIGTERM", () => { void close().then(() => process.exit(0)); });
  process.once("SIGINT", () => { void close().then(() => process.exit(0)); });
}

void main().catch((error: unknown) => {
  console.error("[terminal-runtime] fatal startup failure", error);
  process.exit(1);
});
