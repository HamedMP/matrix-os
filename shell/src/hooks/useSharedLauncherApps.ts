"use client";

import { useMemo } from "react";
import { sharedAppIconUrl, sharedAppTargetName, useSharedAppDirectory } from "@matrix-os/ui/collaborative-app-sharing";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useOwnerCollaborationParticipant } from "@/lib/owner-collaboration-participant";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
import { useShellCollaborationApi } from "@/lib/collaboration-organization";
import { sharedAppWindowPath, sharedAppWindowTitle } from "@/lib/shared-app-target";
import { useWindowManager, type AppEntry } from "@/hooks/useWindowManager";

export function useSharedLauncherApps(enabled: boolean) {
  const origin = useBrowserOrigin();
  const participant = useOwnerCollaborationParticipant();
  const organization = useCollaborationOrganization();
  const identity = `${participant?.actorId ?? ""}:${organization.organizationId ?? ""}`;
  const api = useShellCollaborationApi(origin, enabled && !!participant && organization.status !== "none", identity);
  const directory = useSharedAppDirectory(api, identity, enabled);
  // The collaboration API is same-origin here, so the platform icon path is used as-is.
  const apps = useMemo<AppEntry[]>(() => directory.items.map((target) => {
    const iconUrl = sharedAppIconUrl(target);
    return {
      name: sharedAppTargetName(target), path: sharedAppWindowPath(target), sharedAppTarget: target,
      ...(iconUrl ? { iconUrl } : {}),
    };
  }), [directory.items]);
  return { ...directory, apps };
}

export function openSharedLauncherApp(app: AppEntry): boolean {
  if (!app.sharedAppTarget) return false;
  const state = useWindowManager.getState();
  state.openWindow(sharedAppWindowTitle(app.sharedAppTarget), app.path, 0, { sharedAppTarget: app.sharedAppTarget });
  return true;
}
