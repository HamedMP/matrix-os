"use client";
import { useMemo } from "react";
import { useSeenSharedApps, type ShareOrganization } from "@matrix-os/ui/share";
import { shellApi } from "@/api/http";
import { useShellOrganizationsFor } from "@/components/organization/useShellOrganizations";
import { useOwnerCollaborationParticipant } from "@/lib/owner-collaboration-participant";
import type { AppEntry } from "@/hooks/useWindowManager";

/**
 * Org names/colours and "new until first opened" state for org-shared apps in
 * the Web launcher (spec 2693 phase 3).
 */
export function useLauncherShareContext(shared: { apps: AppEntry[]; loaded: boolean }, open: boolean) {
  const participant = useOwnerCollaborationParticipant();
  const listing = useShellOrganizationsFor(participant?.actorId ?? null);
  const organizations = useMemo<ShareOrganization[]>(() => listing.state === "loaded"
    ? listing.organizations.map(({ organizationId, name, memberCount }) => ({ organizationId, name, memberCount }))
    : [], [listing]);
  const scopeIds = useMemo(() => shared.apps.flatMap((app) => app.sharedAppTarget ? [app.sharedAppTarget.scopeId] : []), [shared.apps]);
  const seen = useSeenSharedApps({ api: shellApi, scopeIds, ready: open && shared.loaded });
  return {
    organizations,
    isNewShared: seen.isNew,
    organizationFor: (app: AppEntry) => organizations.find((item) => item.organizationId === app.sharedAppTarget?.organizationId) ?? null,
    markOpened: (app: AppEntry) => { if (app.sharedAppTarget) seen.markSeen(app.sharedAppTarget.scopeId); },
  };
}
