"use client";

import { useState, useEffect } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { getGatewayUrl } from "@/lib/gateway";
import { MonitorIcon, ActivityIcon, InfoIcon, PaletteIcon } from "lucide-react";

const GATEWAY = getGatewayUrl();

interface SystemInfo {
  version?: string;
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

export default function SystemPage() {
  const [info, setInfo] = useState<SystemInfo>({});
  const [health, setHealth] = useState<HealthStatus | null>(null);

  useEffect(() => {
    fetch(`${GATEWAY}/api/system/info`)
      .then((r) => r.ok ? r.json() : {})
      .then(setInfo)
      .catch(() => {});

    fetch(`${GATEWAY}/health`)
      .then((r) => r.ok ? r.json() : null)
      .then(setHealth)
      .catch(() => {});
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">System</h2>

      {/* Health */}
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

      {/* System Info */}
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

      {/* About */}
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
