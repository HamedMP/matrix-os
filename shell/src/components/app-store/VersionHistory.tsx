"use client";

import { useState, useEffect, useCallback } from "react";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface Version {
  id: string;
  version: string;
  changelog: string | null;
  audit_status: string;
  created_at: string;
}

interface VersionHistoryProps {
  listingId: string;
}

export function VersionHistory({ listingId }: VersionHistoryProps) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchVersions = useCallback(async () => {
    try {
      const res = await fetch(`${GATEWAY_URL}/api/gallery/apps/${listingId}/versions`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const data = await res.json();
      setVersions(Array.isArray(data) ? data : []);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, [listingId]);

  useEffect(() => {
    fetchVersions();
  }, [fetchVersions]);

  if (loading) {
    return <div className="text-xs text-muted-foreground">Loading versions...</div>;
  }

  if (versions.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
        Version History
      </h3>
      <div className="space-y-2">
        {versions.map((v, i) => (
          <div key={v.id} className="border-l-2 border-border pl-3 py-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{v.version}</span>
              {i === 0 && (
                <span className="text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded-full">
                  Latest
                </span>
              )}
              <span className="text-[10px] text-muted-foreground">
                {new Date(v.created_at).toLocaleDateString()}
              </span>
            </div>
            {v.changelog && (
              <p className="text-xs text-muted-foreground mt-0.5">{v.changelog}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
