import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statfsSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { cpus, freemem, loadavg, totalmem } from "node:os";
import { loadSkills, resolveKernelConfigFile } from "@matrix-os/kernel";
import type { HostBundleRelease } from "./system-update.js";

const startTime = Date.now();
const startedAt = new Date(startTime).toISOString();
const SYSTEM_INFO_FILE_MAX_BYTES = 64 * 1024;
const SYSTEM_INFO_CACHE_TTL_MS = 5_000;
const SYSTEM_INFO_CACHE_MAX_ENTRIES = 8;

interface CachedSystemInfoFile<T> {
  expiresAt: number;
  value: T;
}

const systemInfoFileCache = new Map<string, CachedSystemInfoFile<unknown>>();

function readCachedSystemInfoFile<T>(cacheKey: string, read: () => T): T {
  const cached = systemInfoFileCache.get(cacheKey) as CachedSystemInfoFile<T> | undefined;
  if (cached && cached.expiresAt > Date.now()) {
    systemInfoFileCache.delete(cacheKey);
    systemInfoFileCache.set(cacheKey, cached);
    return cached.value;
  }

  const value = read();
  systemInfoFileCache.delete(cacheKey);
  systemInfoFileCache.set(cacheKey, {
    expiresAt: Date.now() + SYSTEM_INFO_CACHE_TTL_MS,
    value,
  });
  while (systemInfoFileCache.size > SYSTEM_INFO_CACHE_MAX_ENTRIES) {
    const oldestKey = systemInfoFileCache.keys().next().value;
    if (oldestKey === undefined) break;
    systemInfoFileCache.delete(oldestKey);
  }
  return value;
}

function readBoundedTextFile(file: string): string {
  const fd = openSync(file, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SYSTEM_INFO_FILE_MAX_BYTES) return "";
    const buffer = Buffer.alloc(stat.size);
    const bytesRead = readSync(fd, buffer, 0, stat.size, 0);
    return buffer.subarray(0, bytesRead).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}

function logSystemInfoReadFailure(context: string, err: unknown): void {
  console.warn(
    `[system-info] ${context}:`,
    err instanceof Error ? err.message : String(err),
  );
}

function isMissingFileError(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

function parseSafeSystemVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed) ? trimmed : undefined;
}

function parseReleaseChannel(value: unknown): string | undefined {
  return typeof value === "string" && ["stable", "canary", "beta", "dev"].includes(value)
    ? value
    : undefined;
}

function parseInstalledRelease(value: unknown): HostBundleRelease | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const parsed = value as HostBundleRelease;
  const version = parseSafeSystemVersion(parsed.version);
  if (!version) return undefined;
  const channel = parseReleaseChannel(parsed.channel);
  const { version: _rawVersion, channel: _rawChannel, ...metadata } = parsed;
  return {
    ...metadata,
    version,
    ...(channel ? { channel } : {}),
  };
}

export function getVersion(release?: HostBundleRelease): string {
  const releaseVersion = parseSafeSystemVersion(release?.version);
  if (releaseVersion) return releaseVersion;
  const bundleVersionFile = process.env.MATRIX_BUNDLE_VERSION_FILE ?? "/opt/matrix/app/BUNDLE_VERSION";
  try {
    const bundleVersion = readCachedSystemInfoFile(`bundle:${bundleVersionFile}`, () => (
      parseSafeSystemVersion(readBoundedTextFile(bundleVersionFile))
    ));
    if (bundleVersion) return bundleVersion;
  } catch (err) {
    if (!isMissingFileError(err)) {
      logSystemInfoReadFailure("Failed to read installed bundle version", err);
    }
  }
  try {
    const legacyVersion = parseSafeSystemVersion(readFileSync("/app/VERSION", "utf-8"));
    if (legacyVersion) return legacyVersion;
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
    return parseSafeSystemVersion(pkg.version) ?? "0.0.0";
  } catch (err) {
    logSystemInfoReadFailure("Failed to read package.json version", err);
  }
  return "0.0.0";
}

export interface SystemInfo {
  version: string;
  channel?: string;
  model: string;
  effort: string;
  image: string;
  runtime: {
    handle: string | null;
    machineId: string | null;
    runtimeSlot: string;
  };
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

function readReleaseInfo(): HostBundleRelease | undefined {
  const candidates = [process.env.MATRIX_RELEASE_FILE ?? "/opt/matrix/release.json"];

  for (const file of candidates) {
    try {
      const release = readCachedSystemInfoFile<HostBundleRelease | undefined>(`release:${file}`, () => {
        try {
          const raw = readBoundedTextFile(file);
          if (!raw) return undefined;
          return parseInstalledRelease(JSON.parse(raw));
        } catch (err) {
          if (isMissingFileError(err)) return undefined;
          throw err;
        }
      });
      if (release) return release;
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

export function getSystemInfo(
  homePath: string,
  kernelOverrides: { model?: string } = {},
): SystemInfo {
  const kernel = resolveKernelConfigFile(homePath);
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
  const release = readReleaseInfo();
  const channel = parseReleaseChannel(release?.channel);

  return {
    version: getVersion(release),
    ...(channel ? { channel } : {}),
    model: kernelOverrides.model ?? kernel.model,
    effort: kernel.effort,
    image: process.env.MATRIX_IMAGE ?? "unknown",
    runtime: {
      handle: process.env.MATRIX_HANDLE ?? null,
      machineId: process.env.MATRIX_MACHINE_ID ?? null,
      runtimeSlot: process.env.MATRIX_RUNTIME_SLOT ?? "primary",
    },
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
    release,
  };
}
