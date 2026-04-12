"use client";

import { useState, useEffect, useCallback } from "react";
import { PackageIcon, Share2Icon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;

interface AppEntry {
  slug: string;
  name: string;
}

interface GroupAppListProps {
  groupSlug: string;
  onOpenApp: (appSlug: string, appName: string) => void;
}

export function GroupAppList({ groupSlug, onOpenApp }: GroupAppListProps) {
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  const fetchApps = useCallback(async () => {
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${groupSlug}/apps`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setApps(data.apps ?? []);
    } catch {
      // network error
    } finally {
      setLoaded(true);
    }
  }, [groupSlug]);

  useEffect(() => {
    setLoaded(false);
    fetchApps();
  }, [fetchApps]);

  if (!loaded) return null;

  if (apps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-12 px-4 text-center">
        <Share2Icon className="size-8 text-foreground/20" />
        <div>
          <p className="text-sm font-medium text-foreground/70">No shared apps yet</p>
          <p className="text-xs text-foreground/50 mt-1">
            Share one from your personal workspace.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3">
      {apps.map((app) => (
        <button
          key={app.slug}
          data-testid={`group-app-${app.slug}`}
          onClick={() => onOpenApp(app.slug, app.name)}
          className="flex flex-col items-center gap-2 p-3 rounded-lg border border-border/30 bg-card/50 hover:bg-card/80 hover:border-border/60 transition-colors"
        >
          <div className="size-10 rounded-lg bg-foreground/5 flex items-center justify-center">
            <PackageIcon className="size-5 text-foreground/40" />
          </div>
          <span className="text-xs text-foreground/80 truncate max-w-full">{app.name}</span>
        </button>
      ))}
    </div>
  );
}
