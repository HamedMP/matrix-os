import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const UPDATE_CHECK_TIMEOUT_MS = 10_000;
const UPDATE_CHANNELS = new Set(["stable", "canary", "beta", "dev"]);

export type UpdateSeverity = "security" | "critical" | "normal";
export type UpdateType = "auto" | "manual";

export interface HostBundleRelease {
  schemaVersion?: number;
  kind?: string;
  version?: string;
  channel?: string;
  gitCommit?: string;
  gitRef?: string;
  buildTime?: string;
  published?: string;
  sha256?: string;
  size?: number;
  bundleSha256?: string;
  installedAt?: string;
  createdAt?: string;
  severity?: UpdateSeverity;
  changelog?: string;
  updateType?: UpdateType;
  files?: {
    bundle?: {
      path?: string;
      sha256?: string;
      size?: number;
    };
    checksum?: {
      path?: string;
      sha256?: string;
      size?: number;
    };
  };
}

export function isAutoApplyUpdate(input: { severity?: string; updateType?: string }): boolean {
  return input.severity === "security" || input.updateType === "auto";
}

export interface SystemUpdateCheck {
  channel: string;
  installed: HostBundleRelease | null;
  latest: HostBundleRelease | null;
  updateAvailable: boolean;
  checkedAt: string;
  error?: string;
}

export interface SystemReleaseList {
  channel: UpdateChannel;
  releases: HostBundleRelease[];
  generatedAt: string;
  error?: string;
}

export type UpdateChannel = "stable" | "canary" | "beta" | "dev";

export function parseUpdateChannel(value: unknown): UpdateChannel | null {
  if (typeof value !== "string") return null;
  return UPDATE_CHANNELS.has(value) ? value as UpdateChannel : null;
}

export function resolveSystemUpdateChannel(
  requested: unknown,
  options: {
    envChannel?: unknown;
    installedChannel?: unknown;
    fallback?: UpdateChannel;
  } = {},
): UpdateChannel | null {
  if (typeof requested === "string" && requested.length > 0) {
    return parseUpdateChannel(requested);
  }
  return (
    parseUpdateChannel(options.envChannel) ??
    parseUpdateChannel(options.installedChannel) ??
    options.fallback ??
    "stable"
  );
}

const UPDATE_VERSION_RE = /^(?:v[0-9]|main-[A-Za-z0-9])[A-Za-z0-9._-]{0,127}$/;

export function parseUpdateVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return UPDATE_VERSION_RE.test(trimmed) ? trimmed : null;
}

export type InternalUpgradeTarget =
  | { type: "version"; value: string }
  | { type: "channel"; value: UpdateChannel };

export function parseInternalUpgradeTarget(body: unknown):
  | { ok: true; target: InternalUpgradeTarget | null }
  | { ok: false; error: string } {
  if (body === undefined || body === null) return { ok: true, target: null };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Invalid upgrade request" };
  }

  const record = body as Record<string, unknown>;
  const hasVersion = record.version !== undefined && record.version !== null && record.version !== "";
  const hasChannel = record.channel !== undefined && record.channel !== null && record.channel !== "";
  if (hasVersion && hasChannel) {
    return { ok: false, error: "Specify either version or channel" };
  }
  if (hasVersion) {
    const version = parseUpdateVersion(record.version);
    if (!version) return { ok: false, error: "Invalid update version" };
    return { ok: true, target: { type: "version", value: version } };
  }
  if (hasChannel) {
    const channel = parseUpdateChannel(record.channel);
    if (!channel) return { ok: false, error: "Invalid update channel" };
    return { ok: true, target: { type: "channel", value: channel } };
  }
  return { ok: true, target: null };
}

export function resolveInternalUpgradeStartTarget(
  body: unknown,
  options: {
    envChannel?: unknown;
    installedChannel?: unknown;
  } = {},
):
  | { ok: true; target: InternalUpgradeTarget }
  | { ok: false; error: string } {
  const parsed = parseInternalUpgradeTarget(body);
  if (!parsed.ok) return parsed;
  if (parsed.target) return { ok: true, target: parsed.target };

  return {
    ok: true,
    target: {
      type: "channel",
      value: resolveSystemUpdateChannel(undefined, options) ?? "stable",
    },
  };
}

export async function writeInternalUpgradeTrigger(options: {
  body: unknown;
  appDir?: string;
  writeFileImpl?: typeof writeFile;
  rmImpl?: typeof rm;
  mkdirImpl?: typeof mkdir;
}): Promise<
  | { ok: true; target: InternalUpgradeTarget | null }
  | { ok: false; error: string }
> {
  const parsed = parseInternalUpgradeTarget(options.body);
  if (!parsed.ok) return parsed;

  const appDir = options.appDir ?? process.env.MATRIX_APP_DIR ?? "/opt/matrix/app";
  const writeFileImpl = options.writeFileImpl ?? writeFile;
  const rmImpl = options.rmImpl ?? rm;
  const mkdirImpl = options.mkdirImpl ?? mkdir;

  await mkdirImpl(appDir, { recursive: true });
  if (parsed.target?.type === "version") {
    await writeFileImpl(join(appDir, ".update-version"), parsed.target.value);
    await rmImpl(join(appDir, ".update-channel"), { force: true });
  } else if (parsed.target?.type === "channel") {
    await writeFileImpl(join(appDir, ".update-channel"), parsed.target.value);
    await rmImpl(join(appDir, ".update-version"), { force: true });
  }
  await writeFileImpl(join(appDir, ".update-now"), "");

  return parsed;
}

function parseReleaseNumber(version: string | undefined): number[] | null {
  if (!version) return null;
  const match = version.match(/^v?(\d{4})\.(\d{2})\.(\d{2})(?:[-.](\d+))?/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4] ?? 0)];
}

export function compareHostBundleVersions(
  latest: Pick<HostBundleRelease, "version" | "gitCommit" | "buildTime"> | null,
  installed: Pick<HostBundleRelease, "version" | "gitCommit" | "buildTime"> | null,
): boolean {
  if (!latest) return false;
  if (!installed) return true;
  if (latest.gitCommit && installed.gitCommit && latest.gitCommit === installed.gitCommit) {
    return false;
  }
  const latestVersion = parseReleaseNumber(latest.version);
  const installedVersion = parseReleaseNumber(installed.version);
  if (latestVersion && installedVersion) {
    for (let i = 0; i < latestVersion.length; i++) {
      if (latestVersion[i] > installedVersion[i]) return true;
      if (latestVersion[i] < installedVersion[i]) return false;
    }
    return false;
  }
  if (latest.buildTime && installed.buildTime) {
    return Date.parse(latest.buildTime) > Date.parse(installed.buildTime);
  }
  return latest.version !== installed.version;
}

function isExpectedAccessFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ENOTDIR";
}

export async function fetchHostBundleChannelManifest(options: {
  platformUrl: string;
  channel: UpdateChannel;
  fetchImpl?: typeof fetch;
}): Promise<HostBundleRelease> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL(`/system-bundles/channels/${options.channel}.json`, options.platformUrl);
  const res = await fetchImpl(url.toString(), {
    signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`channel manifest unavailable: ${res.status}`);
  }
  return await res.json() as HostBundleRelease;
}

export async function checkForSystemUpdate(options: {
  installed: HostBundleRelease | null;
  platformUrl?: string;
  channel: UpdateChannel;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<SystemUpdateCheck> {
  const checkedAt = (options.now ?? new Date()).toISOString();
  if (!options.platformUrl) {
    return {
      channel: options.channel,
      installed: options.installed,
      latest: null,
      updateAvailable: false,
      checkedAt,
      error: "Update checks not configured",
    };
  }

  try {
    const latest = await fetchHostBundleChannelManifest({
      platformUrl: options.platformUrl,
      channel: options.channel,
      fetchImpl: options.fetchImpl,
    });
    return {
      channel: options.channel,
      installed: options.installed,
      latest,
      updateAvailable: compareHostBundleVersions(latest, options.installed),
      checkedAt,
    };
  } catch (err: unknown) {
    console.warn(
      "[system-update] Failed to check host bundle channel:",
      err instanceof Error ? err.message : String(err),
    );
    return {
      channel: options.channel,
      installed: options.installed,
      latest: null,
      updateAvailable: false,
      checkedAt,
      error: "Update check failed",
    };
  }
}

export async function listSystemReleases(options: {
  platformUrl?: string;
  channel: UpdateChannel;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<SystemReleaseList> {
  const generatedAt = (options.now ?? new Date()).toISOString();
  if (!options.platformUrl) {
    return {
      channel: options.channel,
      releases: [],
      generatedAt,
      error: "Release list not configured",
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("/system-bundles/releases", options.platformUrl);
  url.searchParams.set("channel", options.channel);
  try {
    const res = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`release list unavailable: ${res.status}`);
    }
    const data = await res.json() as { releases?: unknown; generatedAt?: unknown };
    const releases = Array.isArray(data.releases)
      ? data.releases.filter((release): release is HostBundleRelease => (
          release !== null &&
          typeof release === "object" &&
          typeof (release as { version?: unknown }).version === "string"
        ))
      : [];
    return {
      channel: options.channel,
      releases,
      generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : generatedAt,
    };
  } catch (err: unknown) {
    console.warn(
      "[system-update] Failed to list host bundle releases:",
      err instanceof Error ? err.message : String(err),
    );
    return {
      channel: options.channel,
      releases: [],
      generatedAt,
      error: "Release list unavailable",
    };
  }
}

export async function startSystemUpdate(options: {
  channel?: UpdateChannel;
  target?: InternalUpgradeTarget;
  updateCommand?: string;
  spawnImpl?: typeof spawn;
}): Promise<{ ok: true; status: "started" } | { ok: false; status: "not_configured" }> {
  const target = options.target ?? (options.channel ? { type: "channel" as const, value: options.channel } : null);
  if (!target) return { ok: false, status: "not_configured" };

  const updateCommand = options.updateCommand ?? process.env.MATRIX_UPDATE_COMMAND ?? "/opt/matrix/bin/matrix-update";
  try {
    await access(updateCommand, constants.X_OK);
  } catch (err: unknown) {
    if (!isExpectedAccessFailure(err)) {
      console.warn(
        "[system-update] Failed to check updater command:",
        err instanceof Error ? err.message : String(err),
      );
    }
    return { ok: false, status: "not_configured" };
  }

  const spawnImpl = options.spawnImpl ?? spawn;
  const child = spawnImpl("sudo", ["-n", updateCommand, target.value], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }) as ChildProcess;
  child.unref();
  return { ok: true, status: "started" };
}
