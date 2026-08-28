import { useCallback, useEffect, useRef, useState } from "react";
import { useConnection } from "../../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../../stores/runtime-generation";
import { AlertTriangle, ArrowUpCircleIcon, LoaderCircle, RefreshCw } from "../../../lib/hugeicons";
import { Card, Empty, Row, SettingsSectionHeader } from "./section-kit";

const RELEASE_CHANNELS = ["stable", "canary", "beta", "dev"] as const;
type ReleaseChannel = typeof RELEASE_CHANNELS[number];
const UPDATE_POLL_INTERVAL_MS = 5_000;
const UPDATE_POLL_TIMEOUT_MS = 5 * 60_000;

interface SystemRelease {
  version?: string;
  channel?: string;
  gitCommit?: string;
  buildTime?: string;
  severity?: string;
  changelog?: string;
}

interface SystemInfo {
  version?: string;
  updateChannel?: string;
  runtime?: { handle?: string; runtimeSlot?: string; machineId?: string };
  resources?: { cpuCount?: number; memoryTotal?: number; memoryFree?: number; diskTotal?: number; diskFree?: number };
  release?: { version?: string; channel?: string; gitCommit?: string; buildTime?: string };
}

interface SystemUpdateStatus {
  channel?: string;
  latest?: SystemRelease | null;
  updateAvailable?: boolean;
  error?: string;
  installError?: { message?: string } | null;
}

interface ReleaseList { releases?: SystemRelease[]; error?: string; }

function gb(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "–";
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function channel(value: unknown): ReleaseChannel {
  return RELEASE_CHANNELS.includes(value as ReleaseChannel) ? value as ReleaseChannel : "stable";
}

function formatBuildId(gitCommit?: string): string | null {
  return gitCommit ? `Build ID ${gitCommit.slice(0, 12)}` : null;
}

function releaseNumber(version?: string): number[] | null {
  const match = version?.match(/^v?(\d{4})\.(\d{2})\.(\d{2})(?:[-.](\d+))?/);
  return match ? [1, 2, 3, 4].map((index) => Number(match[index] ?? 0)) : null;
}

function compareReleaseToInstalled(version: string | undefined, installed: string | undefined): number {
  const candidate = releaseNumber(version);
  const current = releaseNumber(installed);
  if (!candidate || !current) return 1;
  for (let index = 0; index < candidate.length; index += 1) {
    const candidatePart = candidate[index] ?? 0;
    const currentPart = current[index] ?? 0;
    if (candidatePart !== currentPart) return candidatePart > currentPart ? 1 : -1;
  }
  return 0;
}

export default function SystemSection() {
  const api = useConnection((s) => s.api);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const [state, setState] = useState<{ info: SystemInfo | null; error: boolean }>({ info: null, error: false });
  const [selectedChannel, setSelectedChannel] = useState<ReleaseChannel>("stable");
  const [update, setUpdate] = useState<SystemUpdateStatus | null>(null);
  const [releaseList, setReleaseList] = useState<ReleaseList | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(false);
  const [installingVersion, setInstallingVersion] = useState<string | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [upgradeMessage, setUpgradeMessage] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const releaseRequestRef = useRef(0);
  const systemInfoRequestRef = useRef(0);

  const loadReleases = useCallback(async (nextChannel: ReleaseChannel) => {
    if (!api) return;
    const request = ++releaseRequestRef.current;
    setLoadingReleases(true);
    setUpgradeError(null);
    try {
      const [nextUpdate, nextReleases] = await Promise.all([
        api.get<SystemUpdateStatus>(`/api/system/update?channel=${nextChannel}`),
        api.get<ReleaseList>(`/api/system/releases?channel=${nextChannel}`),
      ]);
      if (request !== releaseRequestRef.current) return;
      setUpdate(nextUpdate);
      setReleaseList(nextReleases);
    } catch (err: unknown) {
      if (request !== releaseRequestRef.current) return;
      console.warn("[settings] load system releases failed:", err instanceof Error ? err.message : String(err));
      setUpgradeError("Release information is unavailable.");
      setUpdate(null);
      setReleaseList(null);
    } finally {
      if (request === releaseRequestRef.current) setLoadingReleases(false);
    }
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    const request = ++systemInfoRequestRef.current;
    const runtimeGeneration = captureRuntimeGeneration();
    releaseRequestRef.current += 1;
    if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    pollTimeoutRef.current = null;
    setState({ info: null, error: false });
    setUpdate(null);
    setReleaseList(null);
    setLoadingReleases(false);
    setInstallingVersion(null);
    setUpgradeMessage(null);
    setUpgradeError(null);
    if (!api) return () => { cancelled = true; };
    api.get<SystemInfo>("/api/system/info").then((info) => {
      if (cancelled || request !== systemInfoRequestRef.current || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      setState({ info, error: false });
      const installedChannel = channel(info.updateChannel ?? info.release?.channel);
      setSelectedChannel(installedChannel);
      void loadReleases(installedChannel);
    }).catch((err: unknown) => {
      if (cancelled || request !== systemInfoRequestRef.current || !isCurrentRuntimeGeneration(runtimeGeneration)) return;
      console.warn("[settings] load system info failed:", err instanceof Error ? err.message : String(err));
      setState((current) => ({ ...current, error: true }));
    });
    return () => { cancelled = true; };
  }, [api, loadReleases, runtimeSlot]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const waitForInstallation = async (target: {
    version: string;
    runtimeGeneration: number;
  }) => {
    if (!api) return;
    const startedAt = Date.now();
    const poll = async (): Promise<void> => {
      if (!mountedRef.current || !isCurrentRuntimeGeneration(target.runtimeGeneration)) return;
      try {
        const info = await api.get<SystemInfo>("/api/system/info");
        if (!mountedRef.current || !isCurrentRuntimeGeneration(target.runtimeGeneration)) return;
        const installedVersion = info.release?.version;
        const installed = installedVersion === target.version;
        if (installed) {
          setState({ info, error: false });
          setInstallingVersion(null);
          setUpgradeMessage("Update installed successfully.");
          void loadReleases(selectedChannel);
          return;
        }
      } catch (err: unknown) {
        console.warn("[settings] poll system update failed:", err instanceof Error ? err.message : String(err));
      }
      if (!isCurrentRuntimeGeneration(target.runtimeGeneration)) return;
      if (Date.now() - startedAt >= UPDATE_POLL_TIMEOUT_MS) {
        setInstallingVersion(null);
        setUpgradeError("The update is taking longer than expected. Check the System pane again shortly.");
        setUpgradeMessage(null);
        return;
      }
      pollTimeoutRef.current = setTimeout(() => void poll(), UPDATE_POLL_INTERVAL_MS);
    };
    await poll();
  };

  const startUpgrade = async (version?: string) => {
    if (!api) return;
    const runtimeGeneration = captureRuntimeGeneration();
    setInstallingVersion(version ?? selectedChannel);
    setUpgradeError(null);
    setUpgradeMessage(version ? `Installing ${version}…` : `Switching to the ${selectedChannel} channel…`);
    try {
      const result = await api.post<{ version?: string }>(
        "/api/system/update",
        version ? { version } : { channel: selectedChannel },
        { timeoutMs: 10_000 },
      );
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
      const targetVersion = version ?? result.version;
      if (!targetVersion) throw new Error("Update target missing from response");
      setInstallingVersion(targetVersion);
      setUpgradeMessage("Update started. Waiting for the new version to finish installing…");
      void waitForInstallation({ version: targetVersion, runtimeGeneration });
    } catch (err: unknown) {
      console.warn("[settings] start system update failed:", err instanceof Error ? err.message : String(err));
      if (!isCurrentRuntimeGeneration(runtimeGeneration)) return;
      setUpgradeError("The update could not be started.");
      setUpgradeMessage(null);
      setInstallingVersion(null);
    }
  };

  const info = state.info;
  const currentVersion = info?.release?.version ?? info?.version;
  const releases = releaseList?.releases ?? [];
  const latest = update?.latest;

  return (
    <>
      <SettingsSectionHeader title="System" description="Your cloud computer at a glance." />
      <Card>
        {state.error ? <Empty text="System info unavailable." /> : (
          <>
            <Row label="OS version" value={info?.version ?? "–"} />
            <Row label="Release channel" value={info?.release?.channel ?? "–"} />
            <Row label="Machine" value={info?.runtime?.machineId ?? info?.runtime?.handle ?? "–"} />
            <Row label="CPU cores" value={info?.resources?.cpuCount ?? "–"} />
            <Row label="Memory free" value={`${gb(info?.resources?.memoryFree)} of ${gb(info?.resources?.memoryTotal)}`} />
            <Row label="Disk free" value={`${gb(info?.resources?.diskFree)} of ${gb(info?.resources?.diskTotal)}`} />
          </>
        )}
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h4 className="text-md font-normal" style={{ color: "var(--text-primary)" }}>Updates</h4>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Choose a release channel or install a specific version.</p>
          </div>
          <button type="button" aria-label="Refresh releases" onClick={() => void loadReleases(selectedChannel)} disabled={loadingReleases || installingVersion !== null} className="rounded-md p-1.5 disabled:opacity-50">
            <RefreshCw size={16} />
          </button>
        </div>

        <div className="flex items-end gap-3">
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            <span>Release channel</span>
            <select aria-label="Release channel" value={selectedChannel} onChange={(event) => {
              const next = channel(event.target.value);
              setSelectedChannel(next);
              void loadReleases(next);
            }} disabled={loadingReleases || installingVersion !== null} className="h-9 rounded-md border bg-transparent px-2 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}>
              {RELEASE_CHANNELS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          {latest?.version && update?.updateAvailable && (
            <button type="button" onClick={() => void startUpgrade()} disabled={installingVersion !== null} className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--surface-success-emphasis,#288A5B)] px-3 text-sm text-white disabled:opacity-50">
              <ArrowUpCircleIcon size={16} /> Upgrade
            </button>
          )}
        </div>

        <div className="flex flex-col gap-1 text-sm">
          <Row label="Current version" value={currentVersion ?? "–"} />
          <Row label={`Latest ${selectedChannel} release`} value={latest?.version ?? (loadingReleases ? "Checking…" : "–")} />
        </div>

        {(update?.error || releaseList?.error || upgradeError) && <p className="text-sm" style={{ color: "var(--text-danger, #b42318)" }}>{upgradeError ?? update?.error ?? releaseList?.error}</p>}
        {update?.installError?.message && (
          <div className="flex items-start gap-2 rounded-lg border p-3 text-sm" style={{ borderColor: "var(--border-subtle)", color: "var(--text-danger, #b42318)" }}>
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span>{update.installError.message}</span>
          </div>
        )}
        {upgradeMessage && <p className="text-sm" style={{ color: "var(--text-secondary)" }}>{upgradeMessage}</p>}
        {installingVersion && (
          <div role="status" aria-label={`Installing ${installingVersion}`} className="flex flex-col gap-3 rounded-lg border p-3" style={{ borderColor: "var(--border-subtle)" }}>
            <div className="flex items-center gap-2">
              <LoaderCircle size={16} className="animate-spin" style={{ color: "var(--text-primary)" }} />
              <span className="text-sm" style={{ color: "var(--text-primary)" }}>Installing update…</span>
            </div>
            <div className="flex gap-1.5 text-xs" style={{ color: "var(--text-secondary)" }}>
              <span className="flex-1">Download</span>
              <span className="flex-1 text-center">Install</span>
              <span className="flex-1 text-right">Verify</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "var(--bg-surface)" }}>
              <div className="h-full w-1/2 animate-pulse rounded-full" style={{ background: "var(--surface-success-emphasis, #288A5B)" }} />
            </div>
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>Your computer will restart when installation is complete.</p>
          </div>
        )}

        <div className="flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--border-subtle)" }}>
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Available {selectedChannel} releases</span>
          {releases.length === 0 && <Empty text={loadingReleases ? "Loading releases…" : "No releases found."} />}
          {releases.slice(0, 12).map((release) => {
            const comparison = compareReleaseToInstalled(release.version, currentVersion);
            const installed = comparison === 0;
            const action = comparison < 0 ? "Downgrade" : "Upgrade";
            return (
              <div key={release.version ?? release.gitCommit} className="flex items-center justify-between gap-3 rounded-lg border p-3" style={{ borderColor: "var(--border-subtle)" }}>
                <div className="min-w-0">
                  <p className="text-sm font-normal" style={{ color: "var(--text-primary)" }}>{release.version ?? "Unknown version"}</p>
                  {formatBuildId(release.gitCommit) && <p className="text-xs" style={{ color: "var(--text-secondary)" }}>{formatBuildId(release.gitCommit)}</p>}
                </div>
                <button type="button" aria-label={installed ? `${release.version} installed` : `${action} to ${release.version}`} onClick={() => release.version && void startUpgrade(release.version)} disabled={installed || installingVersion !== null} className="shrink-0 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50" style={{ borderColor: "var(--border-subtle)" }}>
                  {installingVersion === release.version ? "Installing…" : installed ? "Installed" : action}
                </button>
              </div>
            );
          })}
        </div>
      </Card>
    </>
  );
}
