import { CollaborativeAppShareSchema, type CollaborativeAppShare } from "@matrix-os/contracts";
import { useEffect, useState } from "react";

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
  useEffect(() => {
    let active = true;
    void api.get(`/api/collaboration/apps/${encodeURIComponent(appId)}/share`)
      .then((value) => { if (active) setShare(value === null ? null : CollaborativeAppShareSchema.parse(value)); })
      .catch((error: unknown) => console.warn("[collaborative-app-share] state unavailable", error instanceof Error ? error.name : "UnknownError"))
      .finally(() => { if (active) setShareKnown(true); });
    return () => { active = false; };
  }, [api, appId]);
  const active = share?.state === "active" || share?.state === "needs_recheck";
  const canOpen = Boolean(organizationId && organizationName && readiness.readiness && (active || readiness.canShare));

  return <div className="flex items-start gap-2">
    {readiness.readiness ? <ReadinessSummary readiness={readiness.readiness} compact />
      : <span role="status" className="py-1 text-xs text-muted-foreground">{readiness.state === "loading"
        ? "Checking collaboration…" : readiness.safeMessage ?? "Collaboration has not been checked."}</span>}
    <button type="button" className="rounded-md border px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50"
      disabled={!shareKnown || !canOpen} onClick={() => setOpen(true)}>{active ? "Manage app sharing" : "Share app"}</button>
    {open && readiness.readiness && organizationId && organizationName ? <CollaborativeAppShareDialog
      appId={appId} api={api} readiness={readiness.readiness} organizationId={organizationId}
      organizationName={organizationName} share={share} onShareChange={setShare} onClose={() => setOpen(false)} /> : null}
  </div>;
}
