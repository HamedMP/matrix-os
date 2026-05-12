import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

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

export type UpdateChannel = "stable" | "canary" | "beta" | "dev";

export function parseUpdateChannel(value: unknown): UpdateChannel | null {
  if (typeof value !== "string") return null;
  return UPDATE_CHANNELS.has(value) ? value as UpdateChannel : null;
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

export async function startSystemUpdate(options: {
  channel: UpdateChannel;
  updateCommand?: string;
  spawnImpl?: typeof spawn;
}): Promise<{ ok: true; status: "started" } | { ok: false; status: "not_configured" }> {
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
  const child = spawnImpl("sudo", ["-n", updateCommand, options.channel], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  }) as ChildProcess;
  child.unref();
  return { ok: true, status: "started" };
}
