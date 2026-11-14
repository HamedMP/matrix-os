import {
  collaborativeAppShareOrganizationId,
  deriveCollaborativeAppShareStatus,
  useCollaborativeAppSharing,
  type CollaborativeAppShareStatus,
} from "@matrix-os/ui/collaborative-app-sharing";
import { Button } from "../../design/primitives";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";
import { DesktopOrganizationMemberList } from "./DesktopOrganizationMemberList";

type Sharing = ReturnType<typeof useCollaborativeAppSharing>;
type Listing = ReturnType<typeof useDesktopOrganizations>;
export type DesktopAppOrgSharing = ReturnType<typeof useDesktopAppOrgSharing>;

function organizationName(id: string | null, listing: Listing): string | null {
  if (!id || listing.state !== "loaded") return null;
  return listing.organizations.find((organization) => organization.organizationId === id)?.name ?? null;
}

function readinessLabel(sharing: Sharing): string {
  if (sharing.state === "loading" || sharing.state === "checking") return "Checking collaboration…";
  if (sharing.state === "ready") return "Ready to share";
  if (sharing.state === "stale") return "App changed; check collaboration again";
  if (sharing.state === "blocked" || sharing.state === "failed") {
    return sharing.readiness?.checks.find((check) => check.status !== "passed" && check.action)?.action
      ?? sharing.safeMessage
      ?? (sharing.state === "failed" ? "Collaboration check failed" : "Collaboration is blocked for this app");
  }
  return sharing.safeMessage ?? "Collaboration has not been checked";
}

function unavailableOrganizationLabel(status: string, listing: Listing): string {
  if (status === "loading") return "Loading organizations…";
  if (status === "unavailable" || listing.state === "failed") return "Organizations are unavailable. Try again later.";
  return "Select an organization to share this app.";
}

/**
 * One owner-sharing controller for the whole popover, so the overview row and the
 * details view always show the same share read and in-flight mutation.
 */
export function useDesktopAppOrgSharing({ appId, api, buildEpoch }: { appId: string; api: ApiClient; buildEpoch: number }) {
  const selectedOrganizationId = useConnection((state) => state.organizationStatus === "member" ? state.organizationId : null);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const listing = useDesktopOrganizations();
  const sharing = useCollaborativeAppSharing({ appId, api, buildEpoch, manageShare: true });
  const status = deriveCollaborativeAppShareStatus(sharing);
  // An existing share's organization owns the roster and recheck, whatever the shell selects now.
  const organizationId = collaborativeAppShareOrganizationId(status, selectedOrganizationId);
  const shared = status.kind === "active" || status.kind === "needs_recheck";
  const busy = sharing.actionState === "loading" || sharing.actionState === "sharing" || sharing.actionState === "stopping";

  const check = () => {
    if (!organizationId) return;
    if (!sharing.shareKnown) void sharing.refreshShare();
    void sharing.recheck({ organizationId });
  };
  const create = async () => {
    if (!organizationId || shared) return;
    await sharing.createShare({ organizationId });
  };
  const stop = async () => { await sharing.stopShare(); };

  return {
    sharing, status, listing, shared, busy, organizationId, organizationStatus,
    organizationName: organizationName(organizationId, listing),
    check, create, stop,
  };
}

const DOT_COLOR: Record<CollaborativeAppShareStatus["kind"], string> = {
  active: "var(--success)",
  needs_recheck: "var(--warning)",
  unavailable: "var(--danger)",
  loading: "transparent",
  not_shared: "transparent",
  stopped: "transparent",
};

function statusLine(controller: DesktopAppOrgSharing): string {
  const { status, organizationName: name, organizationStatus, listing } = controller;
  switch (status.kind) {
    case "loading": return "Checking sharing status…";
    case "unavailable": return "Sharing status unavailable";
    case "active": return "Active for all current members";
    case "needs_recheck": return "Sharing needs a recheck";
    case "stopped": return "Sharing stopped";
    case "not_shared": return controller.organizationId
      ? `${name ?? "Your organization"} · Not shared`
      : unavailableOrganizationLabel(organizationStatus, listing);
  }
}

/** Status text and indicator; green appears only for a freshly confirmed active share. */
export function DesktopAppOrgSharingSummary({ controller }: { controller: DesktopAppOrgSharing }) {
  const { status, shared, organizationName: name } = controller;
  const outlined = status.kind === "loading" || status.kind === "not_shared" || status.kind === "stopped";
  return <>
    <span
      aria-hidden="true"
      data-sharing-status={status.kind}
      className="size-2 shrink-0 rounded-full"
      style={{ background: DOT_COLOR[status.kind], boxShadow: outlined ? "inset 0 0 0 1.5px var(--text-tertiary, var(--text-secondary))" : undefined }}
    />
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium">{shared ? `Shared with ${name ?? "your organization"}` : "Share with your organization"}</span>
      <span className="block truncate text-xs" style={{ color: "var(--text-secondary)" }}>{statusLine(controller)}</span>
    </span>
  </>;
}

function OrganizationShareControls({ controller }: { controller: DesktopAppOrgSharing }) {
  const { sharing, status, shared, busy, organizationId } = controller;
  const checking = sharing.state === "loading" || sharing.state === "checking";
  if (!organizationId) {
    return <p role="status" className="text-xs" style={{ color: "var(--text-secondary)" }}>
      {unavailableOrganizationLabel(controller.organizationStatus, controller.listing)}
    </p>;
  }
  return <>
    {status.kind !== "active" ? (
      <div className="flex items-center justify-between gap-2">
        <p role="status" className="min-w-0 text-xs" style={{ color: "var(--text-secondary)" }}>{readinessLabel(sharing)}</p>
        <Button variant="subtle" className="shrink-0" disabled={checking || busy} onClick={controller.check}>Check collaboration</Button>
      </div>
    ) : null}
    <div className="flex flex-wrap gap-2">
      {shared ? (
        <Button variant="subtle" disabled={!sharing.shareKnown || busy} onClick={() => { void controller.stop(); }}>
          {sharing.actionState === "stopping" ? "Stopping…" : "Stop sharing"}
        </Button>
      ) : (
        <Button variant="primary" disabled={!sharing.shareKnown || !sharing.canShare || busy} onClick={() => { void controller.create(); }}>
          {sharing.actionState === "sharing" ? "Sharing…" : "Share with your org"}
        </Button>
      )}
    </div>
  </>;
}

/** Owner-home app sharing stays separate from Matrix.page publication. */
export function DesktopAppOrgSharingDetails({ controller }: { controller: DesktopAppOrgSharing }) {
  const { sharing, organizationId, organizationName: name } = controller;
  return <div className="space-y-4 text-[13px]">
    <section aria-label="Share with your org" className="space-y-3">
      <div role="status" className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5" style={{ borderColor: "var(--border-default)" }}>
        <DesktopAppOrgSharingSummary controller={controller} />
      </div>
      <p className="text-xs leading-5" style={{ color: "var(--text-secondary)" }}>
        All current members, including guests, can use existing app data and make changes. The app and its data stay on your Matrix. Stopping sharing removes their access without deleting your records.
      </p>
      <OrganizationShareControls controller={controller} />
      {sharing.actionMessage ? <p role="alert" className="text-xs" style={{ color: "var(--danger-text, var(--text-primary))" }}>{sharing.actionMessage}</p> : null}
    </section>
    {organizationId ? (
      <DesktopOrganizationMemberList organizationId={organizationId} organizationName={name ?? "your organization"} />
    ) : null}
  </div>;
}
