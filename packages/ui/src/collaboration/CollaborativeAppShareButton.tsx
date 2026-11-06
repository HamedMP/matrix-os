import { CollaborativeAppShareSchema, type CollaborativeAppShare } from "@matrix-os/contracts";
import { useCallback, useEffect, useState } from "react";

import { CollaborativeAppShareDialog } from "./CollaborativeAppShareDialog.js";
import { ReadinessSummary } from "./ReadinessSummary.js";
import { useCollaborativeAppSharing, type CollaborativeAppReadinessApi } from "./useCollaborativeAppSharing.js";

export interface CollaborativeAppShareApi extends CollaborativeAppReadinessApi {
  delete(path: string, body?: unknown): Promise<unknown>;
}

export function CollaborativeAppShareButton({ appId, api, organizationId, organizationName }: {
  appId: string;
  api: CollaborativeAppShareApi;
  organizationId: string | null;
  organizationName: string | null;
}) {
  const readiness = useCollaborativeAppSharing({ appId, api });
  const [share, setShare] = useState<CollaborativeAppShare | null>(null);
  const [shareKnown, setShareKnown] = useState(false);
  const [open, setOpen] = useState(false);
  const refreshShare = useCallback(async () => {
    const value = await api.get(`/api/collaboration/apps/${encodeURIComponent(appId)}/share`);
    const next = value === null ? null : CollaborativeAppShareSchema.parse(value);
    setShare(next);
    return next;
  }, [api, appId]);
  useEffect(() => {
    let active = true;
    void api.get(`/api/collaboration/apps/${encodeURIComponent(appId)}/share`)
      .then((value) => { if (active) setShare(value === null ? null : CollaborativeAppShareSchema.parse(value)); })
      .catch((error: unknown) => console.warn("[collaborative-app-share] state unavailable", error instanceof Error ? error.name : "UnknownError"))
      .finally(() => { if (active) setShareKnown(true); });
    return () => { active = false; };
  }, [api, appId]);
  const active = share?.state === "active" || share?.state === "needs_recheck";
  const effectiveOrganizationId = active ? share.organizationId : organizationId;
  const effectiveOrganizationName = active
    ? organizationId === share.organizationId ? organizationName ?? share.organizationId : share.organizationId
    : organizationName;
  const canOpen = active || Boolean(effectiveOrganizationId && effectiveOrganizationName && readiness.canShare);
  const handleOpen = async () => {
    if (!active) { setOpen(true); return; }
    setShareKnown(false);
    try {
      await refreshShare();
      setOpen(true);
    } catch (error: unknown) {
      console.warn("[collaborative-app-share] refresh unavailable", error instanceof Error ? error.name : "UnknownError");
    } finally {
      setShareKnown(true);
    }
  };

  return <div className="flex items-start gap-2">
    {readiness.readiness ? <ReadinessSummary readiness={readiness.readiness} compact />
      : <span role="status" className="py-1 text-xs text-muted-foreground">{readiness.state === "loading"
        ? "Checking collaboration…" : readiness.safeMessage ?? "Collaboration has not been checked."}</span>}
    <button type="button" className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!shareKnown || !canOpen} onClick={() => void handleOpen()}>{active ? "Manage app sharing" : "Share app"}</button>
    {open && effectiveOrganizationId && effectiveOrganizationName ? <CollaborativeAppShareDialog
      appId={appId} api={api} readiness={readiness.readiness} organizationId={effectiveOrganizationId}
      organizationName={effectiveOrganizationName} share={share} onShareChange={setShare}
      onRefreshShare={refreshShare} onClose={() => setOpen(false)} /> : null}
  </div>;
}
