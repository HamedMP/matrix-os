"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getGatewayUrl } from "@/lib/gateway";
import { MonitorIcon, ActivityIcon, InfoIcon, ArrowUpCircleIcon, CloudIcon, Code2Icon, AlertTriangleIcon } from "lucide-react";

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
  installError?: {
    code?: string;
    message?: string;
    version?: string;
    availableKb?: number;
    requiredKb?: number;
    failedAt?: string;
    repairAvailable?: boolean;
  } | null;
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
  formatReleaseBuildId,
  formatReleaseBuildShortId,
  releaseActionLabel,
  resolveUpdateFailureNotice,
  resolveUpgradeInstallCopy,
  severityBadgeStyle,
  resolveSystemUpdateState,
} from "./system-update-state";

const RELEASE_CHANNELS = ["stable", "canary", "beta", "dev"] as const;
type ReleaseChannel = typeof RELEASE_CHANNELS[number];

function coerceReleaseChannel(value: unknown): ReleaseChannel {
  return RELEASE_CHANNELS.includes(value as ReleaseChannel) ? value as ReleaseChannel : "stable";
}

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- system info, health, update status, release list, the selected channel, and the several independent upgrade-progress flags are distinct concerns, not a single cohesive state machine; a reducer would not simplify them.
// react-doctor-disable-next-line react-doctor/no-giant-component -- cohesive system panel (health, updates, release list, info) whose handlers share the upgrade lifecycle state and refs (mountedRef, reloadTimeoutRef, releaseRequestIdRef); splitting would scatter that coupled state without reducing complexity. Real decomposition is out of scope for this behavior-preserving pass.
export function SystemSection({ billingActive = true }: { billingActive?: boolean }) {
  const [info, setInfo] = useState<SystemInfo>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [updateStatus, setUpdateStatus] = useState<SystemUpdateStatus | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<ReleaseChannel>("stable");
  const [releaseList, setReleaseList] = useState<SystemReleaseList | null>(null);
  const [releaseLoading, setReleaseLoading] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [repairingUpdate, setRepairingUpdate] = useState(false);
  const [installingTarget, setInstallingTarget] = useState<string | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const [upgradeWaitingIndex, setUpgradeWaitingIndex] = useState(0);
  const releaseRequestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const reloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only teardown must flip the live mountedRef and clear whichever reload timeout is pending at cleanup time; reloadTimeoutRef is reassigned by waitForInstalledUpdate, so snapshotting it at mount would always capture the initial null and never clear an active timer.
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (reloadTimeoutRef.current) {
        clearTimeout(reloadTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!upgrading) return;
    const progressMessageTimer = setInterval(() => {
      setUpgradeWaitingIndex((index) => index + 1);
    }, 7_000);
    return () => clearInterval(progressMessageTimer);
  }, [upgrading]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity is consumed by the mount-bootstrap useEffect dependency array below; removing useCallback would re-run that effect on every render and refetch system info/health in a loop.
  const refreshReleaseData = useCallback(async (channel: ReleaseChannel) => {
    const requestId = releaseRequestIdRef.current + 1;
    releaseRequestIdRef.current = requestId;
    setReleaseLoading(true);
    setUpgradeError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler bailout on the try/finally needed to clear `releaseLoading` only for the latest request id on every path; the code is correct and the finalizer must run whether the loads resolve, reject, or throw.
    try {
      // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await early-returns are stale-request guards (releaseRequestIdRef !== requestId) that can only change DURING this await via a newer invocation, so they cannot be hoisted before it; this is intentional request coalescing, not a skippable synchronous guard.
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

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- one-shot mount bootstrap that loads system info + health from the gateway; both fetches carry AbortSignal.timeout and refreshReleaseData gates its own writes via releaseRequestIdRef, so this is an intentional mount-driven load, not render data. A data-fetching library would add no safety here.
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
  const systemUpdatesLocked = !billingActive;
  const upgradeInstallCopy = resolveUpgradeInstallCopy({
    target: installingTarget,
    message: upgradeMessage,
    statusIndex: upgradeWaitingIndex,
  });
  const updateFailureNotice = resolveUpdateFailureNotice(updateStatus?.installError);

  const waitForInstalledUpdate = async (
    target: { channel?: ReleaseChannel; version?: string },
  ) => {
    const deadline = Date.now() + UPDATE_INSTALL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- ordered poll loop: each iteration intentionally waits, then re-checks install state until the target version lands or the deadline passes; iterations are dependent, not independent operations to parallelize with Promise.all.
      // react-doctor-disable-next-line react-doctor/async-defer-await -- this await IS the poll backoff delay; the following mount guard must run AFTER the wait, so the await cannot be deferred past it without dropping the intended delay-then-check semantics.
      await new Promise((resolve) => setTimeout(resolve, UPDATE_INSTALL_POLL_MS));
      if (!mountedRef.current) return false;
      try {
        const res = await fetch(`${GATEWAY}/api/system/info`, {
          signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
        });
        if (!res.ok) continue;
        // react-doctor-disable-next-line react-doctor/async-defer-await -- the post-await mount/install guards operate on the parsed poll result and on state that can only change during this await; they cannot be hoisted before parsing the response body, so this is intentional polling, not a skippable synchronous guard.
        const nextInfo = await res.json() as SystemInfo;
        const installedVersion = nextInfo.release?.version ?? nextInfo.version;
        const polledChannel = coerceReleaseChannel(nextInfo.release?.channel);
        const channelInstalled = target.channel ? polledChannel === target.channel : true;
        const installed = target.version
          ? installedVersion === target.version && channelInstalled
          : target.channel
            ? channelInstalled && (installedVersion !== currentVersion || target.channel !== installedChannel)
            : installedVersion !== currentVersion;
        if (!mountedRef.current) return false;
        if (installed) {
          setInfo(nextInfo);
          setUpgradeMessage("Installed. Reloading...");
          setUpgrading(false);
          setInstallingTarget(null);
          if (reloadTimeoutRef.current) {
            clearTimeout(reloadTimeoutRef.current);
          }
          reloadTimeoutRef.current = setTimeout(() => window.location.reload(), 2_000);
          return true;
        }
      } catch (err: unknown) {
        console.warn("[system-settings] waiting for update install:", err instanceof Error ? err.message : String(err));
      }
    }
    return false;
  };

  const startUpdate = async (target: { channel?: ReleaseChannel; version?: string }) => {
    if (!billingActive) {
      setUpgradeError("System upgrades are locked until billing is active.");
      return;
    }

    const targetKey = target.version ?? target.channel ?? "stable";
    setUpgrading(true);
    setInstallingTarget(targetKey);
    setUpgradeWaitingIndex(0);
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

    // react-doctor-disable-next-line react-doctor/async-defer-await -- ordered flow: the update POST must complete before we poll for the installed version, and the awaited `installed` result is used immediately below; the post-await mount guard checks state that can only change during this long wait, so the await cannot be deferred past it.
    const installed = await waitForInstalledUpdate(target);
    if (!mountedRef.current) return;
    if (!installed) {
      setUpgradeMessage(null);
      setUpgradeError("Upgrade is still running. Check again in a minute.");
      setUpgrading(false);
      setInstallingTarget(null);
    }
  };

  const handleChannelChange = (value: string) => {
    const channel = coerceReleaseChannel(value);
    setSelectedChannel(channel);
    void refreshReleaseData(channel);
  };

  const handleUpgrade = async () => {
    await startUpdate({ channel: selectedChannel });
  };

  const handleRepairUpdate = async () => {
    if (!billingActive) {
      setUpgradeError("System upgrades are locked until billing is active.");
      return;
    }
    const failedVersion = updateStatus?.installError?.version;
    const targetKey = failedVersion ?? latestVersion ?? selectedChannel;
    setRepairingUpdate(true);
    setUpgrading(true);
    setInstallingTarget(targetKey);
    setUpgradeWaitingIndex(0);
    setUpgradeError(null);
    setUpgradeMessage("Cleaning safe temporary files and retrying the update...");
    try {
      const res = await fetch(`${GATEWAY}/api/system/update/repair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        setUpgradeError("Update cleanup could not start.");
        setUpgradeMessage(null);
        setUpgrading(false);
        setInstallingTarget(null);
        setRepairingUpdate(false);
        return;
      }
    } catch (err: unknown) {
      console.warn("[system-settings] update repair request interrupted:", err instanceof Error ? err.message : String(err));
      setUpgradeError("Update cleanup could not start. Please try again.");
      setUpgradeMessage(null);
      setUpgrading(false);
      setInstallingTarget(null);
      setRepairingUpdate(false);
      return;
    }
    setRepairingUpdate(false);

    const installed = await waitForInstalledUpdate(failedVersion ? { version: failedVersion } : { channel: selectedChannel });
    if (!mountedRef.current) return;
    if (!installed) {
      setUpgradeMessage(null);
      setUpgradeError("Update cleanup started, but the install has not finished yet.");
      setUpgrading(false);
      setInstallingTarget(null);
      void refreshReleaseData(selectedChannel);
    }
  };

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
          {systemUpdatesLocked && (
            <div className="rounded-lg border border-amber-500/25 bg-amber-500/10 p-3 text-xs leading-5 text-amber-800 dark:text-amber-300">
              System upgrades are locked until billing is active.
            </div>
          )}
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
              type="button"
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
          {updateFailureNotice && (
            <div className={`rounded-lg border p-3 ${
              updateFailureNotice.tone === "warning"
                ? "border-amber-500/25 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                : "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"
            }`}>
              <div className="flex items-start gap-2">
                <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{updateFailureNotice.title}</p>
                    <p className="text-xs leading-5">{updateFailureNotice.detail}</p>
                  </div>
                  {updateFailureNotice.actionLabel && (
                    <button
                      type="button"
                      onClick={() => void handleRepairUpdate()}
                      disabled={upgrading || repairingUpdate || systemUpdatesLocked}
                      className="inline-flex items-center justify-center rounded-md border border-current/30 px-3 py-1.5 text-xs font-medium hover:bg-background/60 transition-colors disabled:opacity-50"
                    >
                      {repairingUpdate ? "Starting cleanup..." : updateFailureNotice.actionLabel}
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
          {upgradeError && (
            <p className="text-xs text-red-500">{upgradeError}</p>
          )}
          {upgradeMessage && !upgrading && (
            <p className="text-xs text-muted-foreground">{upgradeMessage}</p>
          )}
          {upgrading && (
            <output
              aria-live="polite"
              aria-label={`${upgradeInstallCopy.title}. ${upgradeInstallCopy.detail}`}
              className="overflow-hidden rounded-lg border border-blue-500/20 bg-blue-500/10 shadow-sm"
            >
              <div className="flex gap-3 p-4">
                <div className="relative flex size-11 shrink-0 items-center justify-center rounded-md bg-blue-600 text-white">
                  <ArrowUpCircleIcon className="size-5 animate-pulse" aria-hidden="true" />
                  <span className="absolute -right-1 -top-1 flex size-5 items-center justify-center rounded-full border border-background bg-background text-blue-600">
                    <CloudIcon className="size-3" aria-hidden="true" />
                  </span>
                </div>
                <div className="min-w-0 flex-1 space-y-3.5">
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      {upgradeInstallCopy.title}
                    </p>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {upgradeInstallCopy.detail}
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <div className="h-1.5 overflow-hidden rounded-full bg-background">
                      <div className="h-full w-1/2 rounded-full bg-blue-600 animate-pulse" />
                    </div>
                    <div className="grid grid-cols-3 gap-1 text-[11px] leading-4 text-muted-foreground">
                      <span className="truncate">Download</span>
                      <span className="truncate text-center">Install</span>
                      <span className="truncate text-right">Verify</span>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 rounded-md border border-border/70 bg-background/70 p-2.5">
                    <Code2Icon className="mt-0.5 size-3.5 shrink-0 text-blue-600" aria-hidden="true" />
                    <p className="text-xs leading-5 text-muted-foreground">{upgradeInstallCopy.statusLine}</p>
                  </div>
                </div>
              </div>
            </output>
          )}
          {canInstallSelectedChannel && (
            <div className="pt-1">
              <button
                type="button"
                onClick={handleUpgrade}
                disabled={upgrading || systemUpdatesLocked}
                className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {upgrading
                  ? "Installing... checking status"
                  : selectedChannel !== installedChannel
                    ? `Switch to ${selectedChannel}`
                    : resolvedUpdate.autoApplying ? "Retry Update" : "Upgrade Now"}
              </button>
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
                        {[formatReleaseBuildId(release.gitCommit), release.buildTime].filter(Boolean).join(" · ")}
                      </p>
                      {selectedChannel === "stable" && release.changelog && (
                        <p className="whitespace-pre-line text-xs leading-5 text-muted-foreground">
                          {release.changelog}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => release.version && void startUpdate({ version: release.version })}
                      disabled={!canInstallRelease || upgrading || systemUpdatesLocked}
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
            ["Build ID", formatReleaseBuildShortId(info.release?.gitCommit)],
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
          ].flatMap(([label, value]) =>
            value
              ? [
                  <div key={label} className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono text-xs">{value}</span>
                  </div>,
                ]
              : [],
          )}
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
