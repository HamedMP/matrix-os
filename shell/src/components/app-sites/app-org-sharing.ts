"use client";

import {
  collaborativeAppShareOrganizationId,
  deriveCollaborativeAppShareStatus,
  useCollaborativeAppSharing,
  type CollaborativeAppReadinessApi,
} from "@matrix-os/ui/collaborative-app-sharing";

export type AppOrgMembershipStatus = "loading" | "none" | "member" | "unavailable";

export type AppOrgListing =
  | { state: "loading" }
  | { state: "loaded"; organizations: readonly { organizationId: string; name: string }[] }
  | { state: "failed" };

/** What a shell knows about the owner's organizations; each shell supplies its own source. */
export interface AppOrgSharingOrganizations {
  /** The organization selected in this shell, or null when the owner is individual or it is unknown. */
  selectedOrganizationId: string | null;
  selectedOrganizationName?: string | null;
  status: AppOrgMembershipStatus;
  listing: AppOrgListing;
}

type Sharing = ReturnType<typeof useCollaborativeAppSharing>;
export type AppOrgSharing = ReturnType<typeof useAppOrgSharing>;

function organizationName(id: string | null, organizations: AppOrgSharingOrganizations): string | null {
  if (!id) return null;
  const listed = organizations.listing.state === "loaded"
    ? organizations.listing.organizations.find((organization) => organization.organizationId === id)?.name
    : undefined;
  return listed ?? (id === organizations.selectedOrganizationId ? organizations.selectedOrganizationName ?? null : null);
}

export function appOrgReadinessLabel(sharing: Sharing): string {
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

export function appOrgUnavailableLabel(controller: Pick<AppOrgSharing, "organizationStatus" | "listing">): string {
  if (controller.organizationStatus === "loading") return "Loading organizations…";
  if (controller.organizationStatus === "unavailable" || controller.listing.state === "failed") {
    return "Organizations are unavailable. Try again later.";
  }
  return "Select an organization to share this app.";
}

export function appOrgStatusLine(controller: AppOrgSharing): string {
  const { status, organizationName: name } = controller;
  switch (status.kind) {
    case "loading": return "Checking sharing status…";
    case "unavailable": return "Sharing status unavailable";
    case "active": return "Active for all current members";
    case "needs_recheck": return "Sharing needs a recheck";
    case "stopped": return "Sharing stopped";
    case "not_shared": return controller.organizationId
      ? `${name ?? "Your organization"} · Not shared`
      : appOrgUnavailableLabel(controller);
  }
}

/**
 * One owner-sharing controller for the whole popover, so the overview row and the
 * details view always show the same share read and in-flight mutation. Each shell
 * supplies its own authenticated API and organization source.
 */
export function useAppOrgSharing({ appId, api, buildEpoch, organizations, onShareChanged }: {
  appId: string;
  api: CollaborativeAppReadinessApi;
  buildEpoch: number;
  organizations: AppOrgSharingOrganizations;
  /** Runs after a confirmed create or stop, e.g. to refresh the open app's collaboration context. */
  onShareChanged?: () => void | Promise<void>;
}) {
  const sharing = useCollaborativeAppSharing({ appId, api, buildEpoch, manageShare: true });
  const status = deriveCollaborativeAppShareStatus(sharing);
  const selectedOrganizationId = organizations.status === "member" ? organizations.selectedOrganizationId : null;
  // An existing share's organization owns the roster and recheck, whatever the shell selects now.
  const organizationId = collaborativeAppShareOrganizationId(status, selectedOrganizationId);
  const shared = status.kind === "active" || status.kind === "needs_recheck";
  const busy = sharing.actionState === "loading" || sharing.actionState === "sharing" || sharing.actionState === "stopping";

  const changed = async () => {
    try {
      await onShareChanged?.();
    } catch (error: unknown) {
      console.warn("[app-org-sharing] share change notification failed", error instanceof Error ? error.name : "UnknownError");
    }
  };
  const check = () => {
    if (!organizationId) return;
    if (!sharing.shareKnown) void sharing.refreshShare();
    void sharing.recheck({ organizationId });
  };
  const create = async () => {
    if (!organizationId || shared) return;
    if (await sharing.createShare({ organizationId })) await changed();
  };
  const stop = async () => {
    if (await sharing.stopShare()) await changed();
  };

  return {
    sharing, status, shared, busy, organizationId,
    organizationStatus: organizations.status,
    listing: organizations.listing,
    organizationName: organizationName(organizationId, organizations),
    check, create, stop,
  };
}
