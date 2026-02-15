import {
  readFileSync,
  existsSync,
  cpSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";

export interface HealthTarget {
  name: string;
  port: number;
  healthPath: string;
}

export interface HealthCheckResult {
  ok: boolean;
  error?: string;
}

export interface ModuleHealth {
  consecutiveFailures: number;
  healingTriggered: boolean;
  lastError?: string;
}

export interface HeartbeatConfig {
  homePath: string;
  intervalMs?: number;
  failureThreshold?: number;
  timeoutMs?: number;
  onHealthFailure: (target: HealthTarget, error: string) => void;
}

export interface Heartbeat {
  check(): Promise<void>;
  start(): void;
  stop(): void;
  getStatus(): Map<string, ModuleHealth>;
}

interface ModuleEntry {
  name: string;
  type?: string;
  path?: string;
  port?: number;
  status?: string;
}

interface ManifestEntry {
  name?: string;
  health?: string;
  port?: number;
}

export function loadHealthCheckTargets(homePath: string): HealthTarget[] {
  const modulesPath = join(homePath, "system/modules.json");
  if (!existsSync(modulesPath)) return [];

  let modules: ModuleEntry[];
  try {
    modules = JSON.parse(readFileSync(modulesPath, "utf-8")) as ModuleEntry[];
  } catch {
    return [];
  }

  const targets: HealthTarget[] = [];

  for (const mod of modules) {
    if (!mod.port) continue;

    let healthPath = "/health";
    const modDir = join(homePath, "modules", mod.name);
    const metaPath = existsSync(join(modDir, "module.json"))
      ? join(modDir, "module.json")
      : join(modDir, "manifest.json");
    if (existsSync(metaPath)) {
      try {
        const manifest = JSON.parse(
          readFileSync(metaPath, "utf-8"),
        ) as ManifestEntry;
        if (manifest.health) healthPath = manifest.health;
      } catch {
        // use default
      }
    }

    targets.push({ name: mod.name, port: mod.port, healthPath });
  }

  return targets;
}

export async function checkModuleHealth(
  port: number,
  healthPath: string,
  timeoutMs: number,
): Promise<HealthCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`http://localhost:${port}${healthPath}`, {
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) return { ok: true };
    return { ok: false, error: `HTTP ${res.status}` };
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg =
      err instanceof Error ? err.message : "Unknown error";
    if (msg.includes("abort") || msg.includes("Abort")) {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: msg };
  }
}

export function backupModule(
  homePath: string,
  moduleName: string,
  modulePath: string,
): string {
  const backupDir = join(homePath, ".backup", moduleName);
  mkdirSync(join(homePath, ".backup"), { recursive: true });

  if (existsSync(backupDir)) {
    rmSync(backupDir, { recursive: true, force: true });
  }

  cpSync(modulePath, backupDir, { recursive: true });
  return backupDir;
}

export function restoreModule(
  homePath: string,
  moduleName: string,
  modulePath: string,
): boolean {
  const backupDir = join(homePath, ".backup", moduleName);
  if (!existsSync(backupDir)) return false;

  rmSync(modulePath, { recursive: true, force: true });
  cpSync(backupDir, modulePath, { recursive: true });
  return true;
}

export function createHeartbeat(config: HeartbeatConfig): Heartbeat {
  const {
    homePath,
    intervalMs = 30000,
    failureThreshold = 3,
    timeoutMs = 5000,
    onHealthFailure,
  } = config;

  const statusMap = new Map<string, ModuleHealth>();
  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  async function check(): Promise<void> {
    const targets = loadHealthCheckTargets(homePath);

    // Clean up entries for modules that no longer exist
    for (const key of statusMap.keys()) {
      if (!targets.find((t) => t.name === key)) {
        statusMap.delete(key);
      }
    }

    for (const target of targets) {
      if (!statusMap.has(target.name)) {
        statusMap.set(target.name, {
          consecutiveFailures: 0,
          healingTriggered: false,
        });
      }

      const health = statusMap.get(target.name)!;
      const result = await checkModuleHealth(target.port, target.healthPath, timeoutMs);

      if (result.ok) {
        health.consecutiveFailures = 0;
        health.healingTriggered = false;
        health.lastError = undefined;
      } else {
        health.consecutiveFailures++;
        health.lastError = result.error;

        if (
          health.consecutiveFailures >= failureThreshold &&
          !health.healingTriggered
        ) {
          health.healingTriggered = true;
          onHealthFailure(target, result.error ?? "Unknown failure");
        }
      }
    }
  }

  function start(): void {
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
      check().catch(() => {});
    }, intervalMs);
  }

  function stop(): void {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
  }

  function getStatus(): Map<string, ModuleHealth> {
    return statusMap;
  }

  return { check, start, stop, getStatus };
}
