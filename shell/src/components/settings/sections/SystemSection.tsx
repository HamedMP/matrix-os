"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getGatewayUrl } from "@/lib/gateway";
import { MonitorIcon, ActivityIcon, InfoIcon, ArrowUpCircleIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();
const SETTINGS_FETCH_TIMEOUT_MS = 10_000;
const UPDATE_INSTALL_POLL_MS = 5_000;
const UPDATE_INSTALL_TIMEOUT_MS = 5 * 60_000;

interface SystemInfo {
  version?: string;
  image?: string;
  release?: {
    version?: string;
    channel?: string;
    gitCommit?: string;
    gitRef?: string;
    buildTime?: string;
    bundleSha256?: string;
    installedAt?: string;
  };
  build?: {
    sha?: string;
    ref?: string;
    date?: string;
  };
  homePath?: string;
  nodeVersion?: string;
  platform?: string;
  uptime?: number;
  startedAt?: string;
  todayCost?: number;
}

interface HealthStatus {
  status: string;
  cronJobs: number;
  channels: Record<string, string>;
  plugins?: number;
}

interface SystemUpdateStatus {
  channel?: string;
  latest?: {
    version?: string;
    channel?: string;
    gitCommit?: string;
    buildTime?: string;
    bundleSha256?: string;
    severity?: string;
    changelog?: string;
    updateType?: string;
  } | null;
  updateAvailable?: boolean;
  checkedAt?: string;
  error?: string;
}

interface SystemRelease {
  version?: string;
  channel?: string;
  gitCommit?: string;
  gitRef?: string;
  buildTime?: string;
  bundleSha256?: string;
  severity?: string;
  changelog?: string;
  updateType?: string;
  createdAt?: string;
}

interface SystemReleaseList {
  channel?: string;
  releases?: SystemRelease[];
  generatedAt?: string;
  error?: string;
}

import {
  normalizeMatrixReleaseTag,
  isNewer,
  releaseActionLabel,
  severityBadgeStyle,
  resolveSystemUpdateState,
} from "./system-update-state";
export { normalizeMatrixReleaseTag, isNewer, releaseActionLabel, severityBadgeStyle, resolveSystemUpdateState };

const RELEASE_CHANNELS = ["stable", "canary", "beta", "dev"] as const;
type ReleaseChannel = typeof RELEASE_CHANNELS[number];

function coerceReleaseChannel(value: unknown): ReleaseChannel {
  return RELEASE_CHANNELS.includes(value as ReleaseChannel) ? value as ReleaseChannel : "stable";
}

export function SystemSection() {
  const [info, setInfo] = useState<SystemInfo>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<ReleaseChannel>("stable");
  const [releaseList, setReleaseList] = useState<SystemReleaseList | null>(null);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [installingTarget, setInstallingTarget] = useState<string | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const releaseRequestIdRef = useRef(0);

  const refreshReleaseData = useCallback(async (channel: ReleaseChannel) => {
    const requestId = releaseRequestIdRef.current + 1;
    releaseRequestIdRef.current = requestId;
    setReleaseLoading(true);
    setUpgradeError(null);
    try {
      const [updateRes, releasesRes] = await Promise.all([
        fetch(`${GATEWAY}/api/system/update?channel=${channel}`, { signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS) }),
        fetch(`${GATEWAY}/api/system/releases?channel=${channel}`, { signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS) }),
      ]);
      const nextUpdateStatus = updateRes.ok ? await updateRes.json() : null;
      const nextReleaseList = releasesRes.ok ? await releasesRes.json() : {
        channel,
        releases: [],
        error: "Release list unavailable",
      };
      if (releaseRequestIdRef.current !== requestId) return;
      setUpdateStatus(nextUpdateStatus);
      setReleaseList(nextReleaseList);
    } catch (err: unknown) {
      if (releaseRequestIdRef.current !== requestId) return;
      console.warn("[system-settings] failed to load release metadata:", err instanceof Error ? err.message : String(err));
      setUpdateStatus(null);
      setReleaseList({ channel, releases: [], error: "Release metadata unavailable" });
    } finally {
      if (releaseRequestIdRef.current === requestId) {
        setReleaseLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    fetch(`${GATEWAY}/api/system/info`, { signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS) })
      .then((r) => r.ok ? r.json() : {})
      .then((data: SystemInfo) => {
        setInfo(data);
        const channel = coerceReleaseChannel(data.release?.channel);
        setSelectedChannel(channel);
        void refreshReleaseData(channel);
      })
      .catch((err: unknown) => {
        console.warn("[system-settings] failed to load system info:", err instanceof Error ? err.message : String(err));
        void refreshReleaseData("stable");
      });

    fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS) })
      .then((r) => r.ok ? r.json() : null)
      .then(setHealth)
      .catch((err: unknown) => {
        console.warn("[system-settings] failed to load health:", err instanceof Error ? err.message : String(err));
      });

  }, [refreshReleaseData]);

  const resolvedUpdate = resolveSystemUpdateState({
    installedVersion: info.release?.version ?? info.version,
    latestVersion: updateStatus?.latest?.version ?? null,
    updateAvailable: updateStatus?.updateAvailable,
    severity: updateStatus?.latest?.severity,
    changelog: updateStatus?.latest?.changelog,
    updateType: updateStatus?.latest?.updateType,
  });
  const currentVersion = resolvedUpdate.currentVersion;
  const latestVersion = resolvedUpdate.latestVersion;
  const updateAvailable = resolvedUpdate.updateAvailable;
  const installedChannel = coerceReleaseChannel(info.release?.channel);
  const releaseRows = releaseList?.releases ?? [];
  const canInstallSelectedChannel = Boolean(latestVersion && (updateAvailable || selectedChannel !== installedChannel));

  const waitForInstalledUpdate = useCallback(async (
    target: { channel?: ReleaseChannel; version?: string },
    expectedVersion?: string,
  ) => {
    const deadline = Date.now() + UPDATE_INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, UPDATE_INSTALL_POLL_MS));
      try {
        const res = await fetch(`${GATEWAY}/api/system/info`, {
          signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        const nextInfo = await res.json() as SystemInfo;
        const installedVersion = nextInfo.release?.version ?? nextInfo.version;
        const installedChannel = coerceReleaseChannel(nextInfo.release?.channel);
        const targetVersion = expectedVersion ?? target.version;
        const versionInstalled = targetVersion
          ? installedVersion === targetVersion
          : installedVersion !== currentVersion;
        const channelInstalled = target.channel ? installedChannel === target.channel : true;
        const installed = versionInstalled && channelInstalled;
        if (installed) {
          setInfo(nextInfo);
          setUpgradeMessage("Installed. Reloading...");
          setTimeout(() => window.location.reload(), 2_000);
          return true;
        }
      } catch (err: unknown) {
        console.warn("[system-settings] waiting for update install:", err instanceof Error ? err.message : String(err));
      }
    }
    return false;
  }, [currentVersion]);

  const startUpdate = useCallback(async (target: { channel?: ReleaseChannel; version?: string }, expectedVersion?: string) => {
    const targetKey = target.version ?? target.channel ?? "stable";
    setUpgrading(true);
    setInstallingTarget(targetKey);
    setUpgradeError(null);
    setUpgradeMessage(`Installing ${targetKey}. This can take a few minutes...`);

    try {
      const res = await fetch(`${GATEWAY}/api/system/update`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(target),
        signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        let message = "Upgrade failed";
        try {
          const data = await res.json();
          if (data && typeof data === "object") {
            const error = (data as { error?: unknown }).error;
            if (typeof error === "string" && error.length <= 120) message = error;
          }
        } catch (err: unknown) {
          console.warn("[system-settings] failed to parse upgrade error:", err instanceof Error ? err.message : String(err));
        }
        setUpgradeError(message);
        setUpgradeMessage(null);
        setUpgrading(false);
        setInstallingTarget(null);
        return;
      }
    } catch (err: unknown) {
      // Connection drop is expected while the container is being replaced.
      console.warn("[system-settings] upgrade request interrupted:", err instanceof Error ? err.message : String(err));
      setUpgradeMessage("Upgrade started. Waiting for services to come back...");
    }

    const installed = await waitForInstalledUpdate(target, expectedVersion);
    if (!installed) {
      setUpgradeMessage(null);
      setUpgradeError("Upgrade is still running. Check again in a minute.");
      setUpgrading(false);
      setInstallingTarget(null);
    }
  }, [waitForInstalledUpdate]);

  const handleChannelChange = useCallback((value: string) => {
    const channel = coerceReleaseChannel(value);
    setSelectedChannel(channel);
    void refreshReleaseData(channel);
  }, [refreshReleaseData]);

  const handleUpgrade = useCallback(async () => {
    await startUpdate({ channel: selectedChannel }, latestVersion ?? undefined);
  }, [latestVersion, selectedChannel, startUpdate]);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">System</h2>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ActivityIcon className="size-4" />
            Health
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Gateway</span>
            <Badge
              variant="outline"
              className={health?.status === "ok"
                ? "bg-green-500/10 text-green-600"
                : "bg-red-500/10 text-red-600"}
            >
              {health?.status ?? "unknown"}
            </Badge>
          </div>
          {health?.channels && Object.entries(health.channels).map(([id, status]) => (
            <div key={id} className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground capitalize">{id}</span>
              <Badge
                variant="outline"
                className={`text-xs ${
                  status === "connected" ? "text-green-600" :
                  status === "error" ? "text-red-600" : "text-muted-foreground"
                }`}
              >
                {status}
              </Badge>
            </div>
          ))}
          {health && (
            <>
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Cron Jobs</span>
                <span className="text-sm">{health.cronJobs}</span>
              </div>
              {typeof health.plugins === "number" && (
                <div className="flex items-center gap-3">
                  <span className="text-sm text-muted-foreground">Plugins</span>
                  <span className="text-sm">{health.plugins}</span>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <ArrowUpCircleIcon className="size-4" />
            Updates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="space-y-1.5">
              <label htmlFor="release-channel" className="text-xs font-medium text-muted-foreground">
                Release channel
              </label>
              <select
                id="release-channel"
                value={selectedChannel}
                onChange={(event) => handleChannelChange(event.target.value)}
                disabled={releaseLoading || upgrading}
                className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-50"
              >
                {RELEASE_CHANNELS.map((channel) => (
                  <option key={channel} value={channel}>{channel}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => void refreshReleaseData(selectedChannel)}
              disabled={releaseLoading || upgrading}
              className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted transition-colors disabled:opacity-50"
            >
              {releaseLoading ? "Checking..." : "Check"}
            </button>
          </div>

          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Current version</span>
              <span className="font-mono text-xs text-right">{currentVersion}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Installed channel</span>
              <Badge variant="outline" className="text-xs">{installedChannel}</Badge>
            </div>
            {latestVersion && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Latest {selectedChannel} release</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs">{latestVersion}</span>
                  {updateAvailable && (
                    <Badge variant="outline" className={`text-xs ${severityBadgeStyle(resolvedUpdate.severity)}`}>
                      {resolvedUpdate.severity === "security" ? "Security update" : "Update available"}
                    </Badge>
                  )}
                </div>
              </div>
            )}
          </div>

          {(updateStatus?.error || releaseList?.error) && (
            <p className="text-xs text-muted-foreground">{updateStatus?.error ?? releaseList?.error}</p>
          )}
          {resolvedUpdate.changelog && updateAvailable && (
            <p className="text-xs text-muted-foreground whitespace-pre-line">{resolvedUpdate.changelog}</p>
          )}
          {resolvedUpdate.autoApplying && (
            <p className="text-xs text-red-600 font-medium pt-1">
              This is a security update scheduled for automatic installation. Use the button below if it hasn't taken effect.
            </p>
          )}
          {canInstallSelectedChannel && (
            <div className="pt-1 space-y-2">
              <button
                onClick={handleUpgrade}
                disabled={upgrading}
                className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {upgrading
                  ? "Installing... checking status"
                  : selectedChannel !== installedChannel
                    ? `Switch to ${selectedChannel}`
                    : resolvedUpdate.autoApplying ? "Retry Update" : "Upgrade Now"}
              </button>
              {upgradeError && (
                <p className="text-xs text-red-500">{upgradeError}</p>
              )}
              {upgradeMessage && (
                <p className="text-xs text-muted-foreground">{upgradeMessage}</p>
              )}
            </div>
          )}
          {latestVersion && !canInstallSelectedChannel && (
            <p className="text-xs text-muted-foreground pt-1">
              You are running the latest release for this channel.
            </p>
          )}

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium text-muted-foreground">Available {selectedChannel} releases</p>
              {releaseList?.generatedAt && (
                <span className="text-[11px] text-muted-foreground">
                  {new Date(releaseList.generatedAt).toLocaleString()}
                </span>
              )}
            </div>
            {releaseRows.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {releaseLoading ? "Loading releases..." : "No releases found for this channel."}
              </p>
            )}
            <div className="space-y-2">
              {releaseRows.slice(0, 12).map((release) => {
                const action = releaseActionLabel({
                  candidateVersion: release.version,
                  currentVersion,
                  candidateBuildTime: release.buildTime,
                  currentBuildTime: info.release?.buildTime ?? info.build?.date,
                });
                const canInstallRelease = action !== "Installed" && Boolean(release.version);
                return (
                  <div key={release.version ?? release.gitCommit} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs">{release.version ?? "unknown"}</span>
                        {release.severity && release.severity !== "normal" && (
                          <Badge variant="outline" className={`text-[11px] ${severityBadgeStyle(release.severity)}`}>
                            {release.severity}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-xs text-muted-foreground">
                        {[release.gitCommit?.slice(0, 12), release.buildTime].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <button
                      onClick={() => release.version && void startUpdate({ version: release.version }, release.version)}
                      disabled={!canInstallRelease || upgrading}
                      className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
                    >
                      {installingTarget === release.version ? "Installing" : action}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <InfoIcon className="size-4" />
            Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {[
            ["Version", info.version ?? "0.1.0"],
            ["Host Bundle", info.release?.version],
            ["Channel", info.release?.channel],
            ["Git Commit", info.release?.gitCommit],
            ["Git Ref", info.release?.gitRef],
            ["Bundle Build Time", info.release?.buildTime],
            ["Installed At", info.release?.installedAt],
            ["Bundle SHA256", info.release?.bundleSha256],
            ["Service Started", info.startedAt],
            ["Image", info.image],
            ["Build Ref", info.build?.ref],
            ["Build SHA", info.build?.sha],
            ["Build Date", info.build?.date],
            ["Home Directory", info.homePath],
            ["Node.js", info.nodeVersion],
            ["Platform", info.platform],
            ["Today Cost", info.todayCost != null ? `$${info.todayCost.toFixed(4)}` : undefined],
          ].filter(([, v]) => v).map(([label, value]) => (
            <div key={label} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono text-xs">{value}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <MonitorIcon className="size-4" />
            About
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm space-y-2">
          <p className="font-medium">Matrix OS</p>
          <p className="text-muted-foreground">
            Web 4 -- a unified AI operating system. Built with Claude Agent SDK.
          </p>
          <Separator />
          <div className="flex gap-4 text-xs text-muted-foreground">
            <a href="https://matrix-os.com" target="_blank" rel="noreferrer" className="hover:text-foreground transition-colors">
              matrix-os.com
            </a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
