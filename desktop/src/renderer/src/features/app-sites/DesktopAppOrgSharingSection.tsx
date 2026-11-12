import { useState } from "react";
import { useCollaborativeAppSharing } from "@matrix-os/ui/collaborative-app-sharing";
import { Button } from "../../design/primitives";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";

type Sharing = ReturnType<typeof useCollaborativeAppSharing>;
type Listing = ReturnType<typeof useDesktopOrganizations>;

function organizationName(id: string, listing: Listing): string {
  if (listing.state !== "loaded") return id;
  return listing.organizations.find((organization) => organization.organizationId === id)?.name ?? id;
}

function readinessLabel(sharing: Sharing): string {
  if (sharing.state === "loading" || sharing.state === "checking") return "Checking collaboration…";
  if (sharing.state === "ready") return "Ready to share";
  if (sharing.state === "stale") return "App changed; check collaboration again";
  if (sharing.state === "blocked") {
    return sharing.readiness?.checks.find((check) => check.status !== "passed" && check.action)?.action
      ?? "Collaboration is blocked for this app";
  }
  return sharing.safeMessage ?? "Collaboration has not been checked";
}

function unavailableOrganizationLabel(status: string, listing: Listing): string {
  if (status === "loading") return "Loading organizations…";
  if (status === "unavailable" || listing.state === "failed") return "Organizations are unavailable. Try again later.";
  return "Select an organization to share this app.";
}

function OrganizationShareStatus({ active, sharing, organizationId, organizationStatus, listing }: {
  active: boolean;
  sharing: Sharing;
  organizationId: string | null;
  organizationStatus: string;
  listing: Listing;
}) {
  return <>
    {organizationId ? <p>Active organization: <strong>{organizationName(organizationId, listing)}</strong></p>
      : <p role="status">{unavailableOrganizationLabel(organizationStatus, listing)}</p>}
    {active && sharing.share ? <p role="status">Shared with {organizationName(sharing.share.organizationId, listing)}</p> : null}
  </>;
}

function OrganizationShareActions({ active, sharing, organizationId, sharingBusy, checking, onCheck, onUpdate }: {
  active: boolean;
  sharing: Sharing;
  organizationId: string | null;
  sharingBusy: boolean;
  checking: boolean;
  onCheck: () => void;
  onUpdate: (action: "create" | "stop") => void;
}) {
  return <>
    {organizationId ? <>
      <p role="status">{readinessLabel(sharing)}</p>
      <Button variant="subtle" disabled={checking || sharingBusy} onClick={onCheck}>Check collaboration</Button>
      {!active ? <Button disabled={!sharing.shareKnown || !sharing.canShare || sharingBusy}
        onClick={() => onUpdate("create")}>
        {sharing.actionState === "sharing" ? "Sharing…" : "Share with your org"}
      </Button> : null}
    </> : null}
    {active ? <Button variant="subtle" disabled={!sharing.shareKnown || sharingBusy}
      onClick={() => onUpdate("stop")}>
      {sharing.actionState === "stopping" ? "Stopping…" : "Stop sharing"}
    </Button> : null}
  </>;
}

/** Owner-home app sharing stays separate from Matrix.page publication. */
export function DesktopAppOrgSharingSection({ appId, api, buildEpoch }: {
  appId: string;
  api: ApiClient;
  buildEpoch: number;
}) {
  const organizationId = useConnection((state) => state.organizationStatus === "member" ? state.organizationId : null);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const listing = useDesktopOrganizations();
  const sharing = useCollaborativeAppSharing({ appId, api, buildEpoch, manageShare: true });
  const [notice, setNotice] = useState<string | null>(null);
  const active = sharing.share?.state === "active" || sharing.share?.state === "needs_recheck";
  const sharingBusy = sharing.actionState === "loading" || sharing.actionState === "sharing" || sharing.actionState === "stopping";
  const checking = sharing.state === "loading" || sharing.state === "checking";
  const updateShare = async (action: "create" | "stop") => {
    setNotice(null);
    if (action === "create" && !organizationId) return;
    const next = action === "create"
      ? await sharing.createShare({ organizationId: organizationId! })
      : await sharing.stopShare();
    if (next && action === "stop") setNotice("Sharing stopped");
  };

  return <section aria-label="Share with your org" className="space-y-2 rounded-lg border p-3 text-[13px]"
    style={{ borderColor: "var(--border, var(--border-default))", background: "var(--card, var(--bg-surface))" }}>
    <h3 className="text-sm font-semibold">Share with your org</h3>
    <p className="text-xs leading-5" style={{ color: "var(--muted-foreground, var(--text-secondary))" }}>
      All current members, including guests, can use existing app data and make changes. The app and its data stay on your Matrix. Stopping sharing removes their access without deleting your records.
    </p>
    <OrganizationShareStatus {...{ active, sharing, organizationId, organizationStatus, listing }} />
    <OrganizationShareActions {...{ active, sharing, organizationId, sharingBusy, checking }}
      onCheck={() => { if (organizationId) { setNotice(null); void sharing.recheck({ organizationId }); } }}
      onUpdate={(action) => { void updateShare(action); }} />
    {sharing.actionMessage ? <p role="alert">{sharing.actionMessage}</p> : null}
    {notice ? <p role="status">{notice}</p> : null}
  </section>;
}
