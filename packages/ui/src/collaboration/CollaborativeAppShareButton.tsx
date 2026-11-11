import { useState } from "react";

import { CollaborativeAppShareDialog } from "./CollaborativeAppShareDialog.js";
import { ReadinessSummary } from "./ReadinessSummary.js";
import { useCollaborativeAppSharing, type CollaborativeAppReadinessApi } from "./useCollaborativeAppSharing.js";

export interface CollaborativeAppShareApi extends CollaborativeAppReadinessApi {
  delete(path: string, body?: unknown): Promise<unknown>;
}

export function CollaborativeAppShareButton({ appId, api, organizationId, organizationName, onShareChanged, buildEpoch }: {
  appId: string;
  api: CollaborativeAppShareApi;
  organizationId: string | null;
  organizationName: string | null;
  buildEpoch?: number;
  onShareChanged?: () => Promise<void>;
}) {
  const sharing = useCollaborativeAppSharing({ appId, api, manageShare: true, buildEpoch });
  const [open, setOpen] = useState(false);
  const [opening, setOpening] = useState(false);
  const activeShare = sharing.share?.state === "active" || sharing.share?.state === "needs_recheck" ? sharing.share : null;
  const active = activeShare !== null;
  const effectiveOrganizationId = activeShare ? activeShare.organizationId : organizationId;
  const effectiveOrganizationName = activeShare
    ? organizationId === activeShare.organizationId ? organizationName ?? activeShare.organizationId : activeShare.organizationId
    : organizationName;
  const canOpen = active || Boolean(effectiveOrganizationId && effectiveOrganizationName && sharing.canShare);
  const canCheck = Boolean(effectiveOrganizationId)
    && sharing.state !== "loading"
    && sharing.state !== "checking"
    && sharing.state !== "ready";
  const handleOpen = async () => {
    if (!active) { setOpen(true); return; }
    setOpening(true);
    const refreshed = await sharing.refreshShare();
    if (refreshed.ok) setOpen(true);
    setOpening(false);
  };

  return <div className="flex items-start gap-2">
    {sharing.readiness ? <ReadinessSummary readiness={sharing.readiness} compact />
      : <span role="status" className="py-1 text-xs text-muted-foreground">{sharing.state === "loading"
        ? "Checking collaboration…" : sharing.safeMessage ?? "Collaboration has not been checked."}</span>}
    {canCheck ? <button type="button"
      className="rounded-md border px-2.5 py-1 text-xs font-medium"
      onClick={() => void sharing.recheck({ organizationId: effectiveOrganizationId! })}>
      {sharing.readiness ? "Check again" : "Check collaboration"}
    </button> : null}
    <button type="button" className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
      disabled={opening || !canOpen || (!sharing.shareKnown && !active)} onClick={() => void handleOpen()}>{active ? "Manage app sharing" : "Share app"}</button>
    {open && effectiveOrganizationId && effectiveOrganizationName ? <CollaborativeAppShareDialog
      appId={appId} readiness={sharing.readiness} organizationId={effectiveOrganizationId}
      organizationName={effectiveOrganizationName} share={sharing.share}
      onCreate={async () => {
        const next = await sharing.createShare({ organizationId: effectiveOrganizationId });
        if (next) await notifyShareChanged(onShareChanged);
        return next;
      }}
      onStop={async () => {
        const next = await sharing.stopShare();
        if (next) await notifyShareChanged(onShareChanged);
        return next;
      }}
      stopEnabled={sharing.shareKnown}
      onClose={() => setOpen(false)} /> : null}
  </div>;
}

async function notifyShareChanged(onShareChanged?: () => Promise<void>): Promise<void> {
  try {
    await onShareChanged?.();
  } catch (error: unknown) {
    console.warn("[collaborative-app-share] owner subscription refresh failed", error instanceof Error ? error.name : "UnknownError");
  }
}
