import { readFileSync, existsSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { loadSkills } from "@matrix-os/kernel";
import type { HostBundleRelease } from "./system-update.js";

const startTime = Date.now();
const startedAt = new Date(startTime).toISOString();

function logSystemInfoReadFailure(context: string, err: unknown): void {
  console.warn(
    `[system-info] ${context}:`,
    err instanceof Error ? err.message : String(err),
  );
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

export function getVersion(): string {
  try {
    return readFileSync("/app/VERSION", "utf-8").trim();
  } catch (err) {
    if (!isMissingFileError(err)) {
      logSystemInfoReadFailure("Failed to read /app/VERSION", err);
    }
  }
  try {
    const pkg = JSON.parse(
      readFileSync(
        join(import.meta.dirname, "..", "..", "..", "package.json"),
        "utf-8",
      ),
    );
    return pkg.version ?? "0.0.0";
  } catch (err) {
    logSystemInfoReadFailure("Failed to read package.json version", err);
  }
  return "0.0.0";
}

export interface SystemInfo {
  version: string;
  image: string;
  build: {
    sha: string;
    ref: string;
    date: string;
  };
  uptime: number;
  modules: number;
  channels: Record<string, boolean>;
  skills: number;
  templateVersion: string;
  installedVersion: string;
  startedAt: string;
  resources: {
    cpuCount: number;
    loadAverage: [number, number, number];
    memoryTotalBytes: number;
    memoryFreeBytes: number;
    diskTotalBytes: number | null;
    diskFreeBytes: number | null;
    homeDiskTotalBytes: number | null;
    homeDiskFreeBytes: number | null;
  };
  release?: HostBundleRelease;
}

function readReleaseInfo(homePath: string): HostBundleRelease | undefined {
  const candidates = [
    process.env.MATRIX_RELEASE_FILE,
    "/opt/matrix/release.json",
    join(homePath, "release.json"),
  ].filter((value): value is string => Boolean(value));

  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf-8")) as HostBundleRelease;
      if (parsed && typeof parsed === "object") return parsed;
    } catch (err) {
      logSystemInfoReadFailure("Failed to read release metadata", err);
    }
  }
  return undefined;
}

function readDiskUsage(path: string): { totalBytes: number; freeBytes: number } | null {
  try {
    const stats = statfsSync(path);
    return {
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
      freeBytes: Number(stats.bavail) * Number(stats.bsize),
    };
  } catch (err) {
    logSystemInfoReadFailure(`Failed to read disk usage for ${path}`, err);
    return null;
  }
}

export function getSystemInfo(homePath: string): SystemInfo {
  let modules = 0;
  const modulesPath = join(homePath, "system", "modules.json");
  if (existsSync(modulesPath)) {
    try {
      const data = JSON.parse(readFileSync(modulesPath, "utf-8"));
      modules = Array.isArray(data) ? data.length : 0;
    } catch (err) {
      logSystemInfoReadFailure("Failed to read modules", err);
    }
  }

  const channels: Record<string, boolean> = {};
  const configPath = join(homePath, "system", "config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
      if (cfg.channels) {
        for (const [id, conf] of Object.entries(cfg.channels)) {
          channels[id] = (conf as { enabled?: boolean }).enabled ?? false;
        }
      }
    } catch (err) {
      logSystemInfoReadFailure("Failed to read channel config", err);
    }
  }

  let skills = 0;
  try {
    skills = loadSkills(homePath).length;
  } catch (err) {
    logSystemInfoReadFailure("Failed to count skills", err);
  }

  let templateVersion = "unknown";
  const templateVersionPath = resolve(
    import.meta.dirname, "..", "..", "..", "home", ".matrix-version",
  );
  try {
    if (existsSync(templateVersionPath)) {
      templateVersion = readFileSync(templateVersionPath, "utf-8").trim();
    }
  } catch (err) {
    logSystemInfoReadFailure("Failed to read template version", err);
  }

  let installedVersion = "unknown";
  const installedVersionPath = join(homePath, ".matrix-version");
  try {
    if (existsSync(installedVersionPath)) {
      installedVersion = readFileSync(installedVersionPath, "utf-8").trim();
    }
  } catch (err) {
    logSystemInfoReadFailure("Failed to read installed version", err);
  }

  const rootDisk = readDiskUsage("/");
  const homeDisk = readDiskUsage(homePath);
  const [load1 = 0, load5 = 0, load15 = 0] = loadavg();

  return {
    version: getVersion(),
    image: process.env.MATRIX_IMAGE ?? "unknown",
    build: {
      sha: process.env.MATRIX_BUILD_SHA ?? "unknown",
      ref: process.env.MATRIX_BUILD_REF ?? "unknown",
      date: process.env.MATRIX_BUILD_DATE ?? "unknown",
    },
    uptime: Math.floor((Date.now() - startTime) / 1000),
    modules,
    channels,
    skills,
    templateVersion,
    installedVersion,
    startedAt,
    resources: {
      cpuCount: cpus().length,
      loadAverage: [load1, load5, load15],
      memoryTotalBytes: totalmem(),
      memoryFreeBytes: freemem(),
      diskTotalBytes: rootDisk?.totalBytes ?? null,
      diskFreeBytes: rootDisk?.freeBytes ?? null,
      homeDiskTotalBytes: homeDisk?.totalBytes ?? null,
      homeDiskFreeBytes: homeDisk?.freeBytes ?? null,
    },
    release: readReleaseInfo(homePath),
  };
}
