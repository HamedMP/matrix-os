"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getGatewayUrl } from "@/lib/gateway";
import { MonitorIcon, ActivityIcon, InfoIcon, ArrowUpCircleIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();
const SETTINGS_FETCH_TIMEOUT_MS = 10_000;

interface SystemInfo {
  version?: string;
  image?: string;
  build?: {
    sha?: string;
    ref?: string;
    date?: string;
  };
  homePath?: string;
  nodeVersion?: string;
  platform?: string;
  uptime?: number;
  todayCost?: number;
}

interface HealthStatus {
  status: string;
  cronJobs: number;
  channels: Record<string, string>;
  plugins?: number;
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function normalizeMatrixReleaseTag(tagName: string): string | null {
  if (tagName.startsWith("cli-")) return null;
  const parsed = parseSemver(tagName);
  return parsed ? parsed.join(".") : null;
}

export function isNewer(latest: string, current: string): boolean {
  const a = parseSemver(latest);
  const b = parseSemver(current);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

export function SystemSection() {
  const [info, setInfo] = useState<SystemInfo>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${GATEWAY}/api/system/info`, { signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS) })
      .then((r) => r.ok ? r.json() : {})
      .then(setInfo)
      .catch((err: unknown) => {
        console.warn("[system-settings] failed to load system info:", err instanceof Error ? err.message : String(err));
      });

    fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS) })
      .then((r) => r.ok ? r.json() : null)
      .then(setHealth)
      .catch((err: unknown) => {
        console.warn("[system-settings] failed to load health:", err instanceof Error ? err.message : String(err));
      });

    fetch("https://api.github.com/repos/HamedMP/matrix-os/releases?per_page=20", {
      signal: AbortSignal.timeout(SETTINGS_FETCH_TIMEOUT_MS),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (!Array.isArray(data)) return;
        const appRelease = data
          .map((release: { tag_name?: unknown }) =>
            typeof release.tag_name === "string" ? normalizeMatrixReleaseTag(release.tag_name) : null,
          )
          .find((version: string | null): version is string => version !== null);
        setLatestVersion(appRelease ?? null);
      })
      .catch((err: unknown) => {
        console.warn("[system-settings] failed to load release metadata:", err instanceof Error ? err.message : String(err));
      });
  }, []);

  const [upgrading, setUpgrading] = useState(false);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);

  const handleUpgrade = useCallback(async () => {
    setUpgrading(true);
    setUpgradeError(null);

    try {
      const res = await fetch(`${GATEWAY}/api/system/upgrade`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setUpgradeError((data as Record<string, string>).error ?? "Upgrade failed");
        setUpgrading(false);
        return;
      }
    } catch {
      // Connection drop is expected -- container is being replaced
    }

    // Container will restart; reload after 15s
    setTimeout(() => window.location.reload(), 15000);
  }, []);

  const currentVersion = info.version ?? "0.0.0";
  const updateAvailable = latestVersion ? isNewer(latestVersion, currentVersion) : false;

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
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Current version</span>
            <span className="font-mono text-xs">{currentVersion}</span>
          </div>
          {latestVersion && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Latest release</span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{latestVersion}</span>
                {updateAvailable && (
                  <Badge variant="outline" className="bg-blue-500/10 text-blue-600 text-xs">
                    Update available
                  </Badge>
                )}
              </div>
            </div>
          )}
          {updateAvailable && (
            <div className="pt-1 space-y-2">
              <button
                onClick={handleUpgrade}
                disabled={upgrading}
                className="inline-flex items-center justify-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {upgrading ? "Upgrading... reloading in 15s" : "Upgrade Now"}
              </button>
              {upgradeError && (
                <p className="text-xs text-red-500">{upgradeError}</p>
              )}
            </div>
          )}
          {latestVersion && !updateAvailable && (
            <p className="text-xs text-muted-foreground pt-1">
              You are running the latest version.
            </p>
          )}
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
