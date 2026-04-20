"use client";

import { useState, useEffect, useCallback } from "react";
import { PackageIcon, XIcon, Share2Icon } from "lucide-react";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

const GATEWAY_URL = getGatewayUrl();
const FETCH_TIMEOUT_MS = 10_000;

interface PersonalApp {
  slug: string;
  name: string;
  icon?: string;
}

interface ShareAppPickerProps {
  groupSlug: string;
  existingApps: string[];
  onShared: () => void;
  onClose: () => void;
}

export function ShareAppPicker({ groupSlug, existingApps, onShared, onClose }: ShareAppPickerProps) {
  const [apps, setApps] = useState<PersonalApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState<string | null>(null);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${GATEWAY_URL}/api/apps`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!r.ok) return;
      const data = await r.json();
      setApps(data.apps ?? []);
    } catch {
      // network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function handleShare(appSlug: string) {
    if (sharing) return;
    setSharing(appSlug);
    try {
      const r = await fetch(`${GATEWAY_URL}/api/groups/${groupSlug}/share-app`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_slug: appSlug }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (r.ok) {
        onShared();
      }
    } catch {
      // network error
    } finally {
      setSharing(null);
    }
  }

  const available = apps.filter((a) => !existingApps.includes(a.slug));

  return (
    <div
      data-testid="share-app-picker"
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-80 rounded-xl border border-border/40 bg-card shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border/20">
          <h3 className="text-sm font-semibold">Share an app</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-foreground/10">
            <XIcon className="size-4" />
          </button>
        </div>

        <div className="p-3 max-h-64 overflow-y-auto">
          {loading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-lg" />
              ))}
            </div>
          ) : available.length === 0 ? (
            <p className="text-sm text-foreground/50 text-center py-4">
              {apps.length === 0
                ? "No personal apps found"
                : "All your apps are already shared to this group"}
            </p>
          ) : (
            <div className="space-y-1">
              {available.map((a) => (
                <Button
                  key={a.slug}
                  data-testid={`share-pick-${a.slug}`}
                  variant="outline"
                  className="w-full justify-start gap-2 h-10"
                  disabled={sharing === a.slug}
                  onClick={() => handleShare(a.slug)}
                >
                  <PackageIcon className="size-4 shrink-0 text-foreground/40" />
                  <span className="truncate">{a.name}</span>
                  {sharing === a.slug && (
                    <Share2Icon className="size-3.5 ml-auto animate-pulse" />
                  )}
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
