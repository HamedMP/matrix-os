"use client";
import { useEffect, useState } from "react";
import type { CollaborationDirectApi } from "../collaboration/direct-api.js";
import { subscribeCollaborationDiscoveryChanged } from "../collaboration/discovery-events.js";
import { loadOrganizationDriveOptions, type OrganizationDriveOption } from "./discovery.js";
export function OrganizationDrivesNavigation({api, onOpen, active = true}: {
  api: CollaborationDirectApi | null; active?: boolean; onOpen(drive: OrganizationDriveOption): void;
}) {
  const [snapshot, setSnapshot] = useState<{api: CollaborationDirectApi; drives: OrganizationDriveOption[]} | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true; let inFlight = false;
    setSnapshot(null); setError(false);
    if (!api || !active) return;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const drives = await loadOrganizationDriveOptions(api, {});
        if (current) {setSnapshot({api, drives}); setError(false);}
      } catch (cause: unknown) {
        console.warn("[organization-drive] navigation unavailable", cause instanceof Error ? cause.name : "UnknownError");
        if (current) {setSnapshot(null); setError(true);}
      } finally {inFlight = false;}
    };
    void load();
    const unsubscribe = subscribeCollaborationDiscoveryChanged(() => void load());
    const timer = setInterval(() => void load(), 30_000);
    return () => {current = false; unsubscribe(); clearInterval(timer);};
  }, [api, active]);
  const drives = snapshot?.api === api && active ? snapshot.drives : [];
  if (!api || !active || (!drives.length && !error)) return null;
  return <nav aria-label="Organization drive projects" className="mx-2 mb-2 space-y-1 text-sm">
    <h2 className="px-2 py-1 text-xs font-medium" style={{color: "var(--text-secondary,var(--muted-foreground))"}}>Company drives</h2>
    {error ? <p role="status" className="px-2 text-xs">Drives are unavailable. They will refresh automatically.</p> : null}
    {drives.map(drive => <button type="button" key={drive.scopeId} aria-label={`Open ${drive.name} drive`} onClick={() => onOpen(drive)} className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 text-left hover:bg-[var(--bg-hover,var(--muted))] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="shrink-0"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z"/><path d="M15 12v5m-2.5-2.5h5"/></svg>
      <span className="min-w-0 flex-1 truncate">{drive.name}</span>
      {drive.state === "pending" ? <span className="text-xs">Join</span> : null}
    </button>)}
  </nav>;
}
