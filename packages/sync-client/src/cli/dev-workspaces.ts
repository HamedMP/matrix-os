import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { cliError } from "./output.js";

export const DEV_STATE_DIR = ".matrix/dev";
export const DEV_INSTANCE_DIR = "instances";
export const DEFAULT_SHELL_PORT_START = 3100;
export const DEFAULT_GATEWAY_PORT_START = 4100;
export const DEFAULT_PORT_SCAN_LIMIT = 100;
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCK_POLL_MS = 100;

export interface DevInstance {
  name: string;
  slug: string;
  repoPath: string;
  projectName: string;
  envPath: string;
  metadataPath: string;
  shellPort: number;
  gatewayPort: number;
  exposure: "local" | "public";
  status: "created" | "running" | "stopped" | "failed";
  createdAt: string;
  updatedAt: string;
}

export interface CreateDevInstanceOptions {
  repoPath: string;
  name?: string;
  homeDir?: string;
  shellPortStart?: number;
  gatewayPortStart?: number;
  portScanLimit?: number;
  isPortFree?: (port: number) => Promise<boolean>;
  now?: () => Date;
}

export interface CommandRunner {
  (command: string, args: string[], options: { cwd: string; stdio: "inherit" | "pipe" }): Promise<void>;
}

export function matrixDevDir(homeDir = homedir()): string {
  return join(homeDir, DEV_STATE_DIR);
}

export function matrixDevInstancesDir(homeDir = homedir()): string {
  return join(matrixDevDir(homeDir), DEV_INSTANCE_DIR);
}

function instanceMetadataPath(homeDir: string, name: string): string {
  return join(matrixDevInstancesDir(homeDir), `${name}.json`);
}

function instanceEnvPath(homeDir: string, name: string): string {
  return join(matrixDevInstancesDir(homeDir), `${name}.env`);
}

function lockPath(homeDir: string): string {
  return join(matrixDevDir(homeDir), ".allocation.lock");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function normalizeDevInstanceName(value: string): string {
  const name = value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) {
    throw cliError("invalid_dev_name", "Dev instance names must match [a-z0-9][a-z0-9-]{0,62}.");
  }
  return name;
}

export function deriveDevInstanceName(repoPath: string): string {
  const raw = basename(resolve(repoPath)).toLowerCase();
  const slug = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  return normalizeDevInstanceName(slug || "main");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function assertMatrixRepo(repoPath: string): Promise<string> {
  const resolved = resolve(repoPath);
  const required = ["package.json", "pnpm-workspace.yaml", "docker-compose.dev-vps.yml"];
  const missing: string[] = [];
  for (const file of required) {
    if (!(await pathExists(join(resolved, file)))) {
      missing.push(file);
    }
  }
  if (missing.length > 0) {
    throw cliError("invalid_dev_repo", `Not a Matrix OS checkout; missing ${missing.join(", ")}.`);
  }
  return resolved;
}

async function acquireAllocationLock(homeDir: string, timeoutMs = DEFAULT_LOCK_TIMEOUT_MS): Promise<FileHandle> {
  await mkdir(matrixDevDir(homeDir), { recursive: true, mode: 0o700 });
  const started = Date.now();
  const path = lockPath(homeDir);
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return handle;
    } catch (err: unknown) {
      if (!(err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "EEXIST")) {
        throw err;
      }
      if (Date.now() - started >= timeoutMs) {
        throw cliError("dev_lock_timeout", "Timed out waiting for the Matrix dev workspace allocation lock.");
      }
      await sleep(DEFAULT_LOCK_POLL_MS);
    }
  }
}

async function releaseAllocationLock(homeDir: string, handle: FileHandle): Promise<void> {
  await handle.close();
  await rm(lockPath(homeDir), { force: true });
}

async function writeAtomic(path: string, contents: string, mode = 0o600): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, contents, { mode, flag: "wx" });
  await rename(tmp, path);
}

export async function loadDevInstances(homeDir = homedir()): Promise<DevInstance[]> {
  const dir = matrixDevInstancesDir(homeDir);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const instances: DevInstance[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(join(dir, entry), "utf8")) as DevInstance;
    instances.push(parsed);
  }
  return instances.sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadDevInstance(name: string, homeDir = homedir()): Promise<DevInstance> {
  const normalized = normalizeDevInstanceName(name);
  try {
    return JSON.parse(await readFile(instanceMetadataPath(homeDir, normalized), "utf8")) as DevInstance;
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code === "ENOENT") {
      throw cliError("dev_instance_not_found", `Dev instance '${normalized}' was not found.`);
    }
    throw err;
  }
}

export async function defaultIsPortFree(port: number): Promise<boolean> {
  return await new Promise((resolveFree) => {
    const server = createServer();
    server.once("error", () => resolveFree(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolveFree(true));
    });
  });
}

async function allocatePortPair(input: {
  existing: DevInstance[];
  shellPortStart: number;
  gatewayPortStart: number;
  scanLimit: number;
  isPortFree: (port: number) => Promise<boolean>;
}): Promise<{ shellPort: number; gatewayPort: number }> {
  const used = new Set<number>();
  for (const instance of input.existing) {
    used.add(instance.shellPort);
    used.add(instance.gatewayPort);
  }
  for (let offset = 0; offset < input.scanLimit; offset += 1) {
    const shellPort = input.shellPortStart + offset;
    const gatewayPort = input.gatewayPortStart + offset;
    if (used.has(shellPort) || used.has(gatewayPort)) continue;
    if ((await input.isPortFree(shellPort)) && (await input.isPortFree(gatewayPort))) {
      return { shellPort, gatewayPort };
    }
  }
  throw cliError("dev_ports_unavailable", "No free Matrix dev shell/gateway port pair was found.");
}

function envForInstance(instance: DevInstance): string {
  const dbName = `matrixos_${instance.slug.replace(/-/g, "_")}`;
  return [
    `MATRIX_DEV_INSTANCE=${instance.slug}`,
    "MATRIX_DEV_EXPOSURE=local",
    `MATRIX_DEV_SHELL_PORT=${instance.shellPort}`,
    `MATRIX_DEV_GATEWAY_PORT=${instance.gatewayPort}`,
    `MATRIX_DEV_GATEWAY_URL=http://127.0.0.1:${instance.gatewayPort}`,
    `MATRIX_DEV_GATEWAY_WS=ws://127.0.0.1:${instance.gatewayPort}/ws`,
    "MATRIX_DEV_SHELL_INTERNAL_PORT=3000",
    "MATRIX_DEV_GATEWAY_INTERNAL_PORT=4000",
    `DEV_VPS_POSTGRES_DB=${dbName}`,
    `DEV_VPS_PLATFORM_DB=${dbName}_platform`,
    `DEV_VPS_S3_BUCKET=matrixos-sync-${instance.slug}`,
    `DEV_VPS_HANDLE=${instance.slug}`,
    `DEV_VPS_DISPLAY_NAME=Matrix Dev ${instance.slug}`,
    "",
  ].join("\n");
}

export async function createOrUpdateDevInstance(options: CreateDevInstanceOptions): Promise<DevInstance> {
  const homeDir = options.homeDir ?? homedir();
  const repoPath = await assertMatrixRepo(options.repoPath);
  const name = normalizeDevInstanceName(options.name ?? deriveDevInstanceName(repoPath));
  await mkdir(matrixDevInstancesDir(homeDir), { recursive: true, mode: 0o700 });

  const lock = await acquireAllocationLock(homeDir);
  try {
    const existing = await loadDevInstances(homeDir);
    const current = existing.find((instance) => instance.name === name);
    const now = (options.now ?? (() => new Date()))().toISOString();
    const ports = current
      ? { shellPort: current.shellPort, gatewayPort: current.gatewayPort }
      : await allocatePortPair({
          existing,
          shellPortStart: options.shellPortStart ?? DEFAULT_SHELL_PORT_START,
          gatewayPortStart: options.gatewayPortStart ?? DEFAULT_GATEWAY_PORT_START,
          scanLimit: options.portScanLimit ?? DEFAULT_PORT_SCAN_LIMIT,
          isPortFree: options.isPortFree ?? defaultIsPortFree,
        });
    const instance: DevInstance = {
      name,
      slug: name,
      repoPath,
      projectName: `matrix-dev-${name}`,
      envPath: instanceEnvPath(homeDir, name),
      metadataPath: instanceMetadataPath(homeDir, name),
      shellPort: ports.shellPort,
      gatewayPort: ports.gatewayPort,
      exposure: "local",
      status: current?.status ?? "created",
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await writeAtomic(instance.envPath, envForInstance(instance));
    await writeAtomic(instance.metadataPath, `${JSON.stringify(instance, null, 2)}\n`);
    return instance;
  } finally {
    await releaseAllocationLock(homeDir, lock);
  }
}

export async function saveDevInstance(instance: DevInstance): Promise<void> {
  await writeAtomic(instance.metadataPath, `${JSON.stringify(instance, null, 2)}\n`);
}

export async function removeDevInstanceFiles(instance: DevInstance): Promise<void> {
  await rm(instance.envPath, { force: true });
  await rm(instance.metadataPath, { force: true });
}

export function composeArgs(instance: DevInstance, command: "up" | "stop" | "down" | "logs", extra: string[] = []): string[] {
  const base = ["compose", "--env-file", instance.envPath, "-f", join(instance.repoPath, "docker-compose.dev-vps.yml"), "-p", instance.projectName];
  if (command === "up") return [...base, "up", "-d", ...extra];
  if (command === "down") return [...base, "down", ...extra];
  return [...base, command, ...extra];
}

export const defaultCommandRunner: CommandRunner = async (command, args, options) => {
  await new Promise<void>((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: options.stdio });
    child.once("error", rejectRun);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(cliError("dev_command_failed", `${command} failed with ${signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`}.`));
    });
  });
};
