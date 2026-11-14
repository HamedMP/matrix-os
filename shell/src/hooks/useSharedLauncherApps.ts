"use client";

import { useMemo } from "react";
import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { sharedAppPresentation, useSharedAppDirectory } from "@matrix-os/ui/collaborative-app-sharing";
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
  const apps = useMemo<AppEntry[]>(() => directory.items.map(sharedLauncherAppEntry), [directory.items]);
  return { ...directory, apps };
}

/** The web shell is served from the platform origin, so member-gated artwork paths stay relative. */
export function sharedLauncherAppEntry(target: CollaborativeAppDirectoryItem): AppEntry {
  return { ...sharedAppPresentation(target), path: sharedAppWindowPath(target), sharedAppTarget: target };
}

export function openSharedLauncherApp(app: AppEntry): boolean {
  if (!app.sharedAppTarget) return false;
  const state = useWindowManager.getState();
  state.openWindow(sharedAppWindowTitle(app.sharedAppTarget), app.path, 0, { sharedAppTarget: app.sharedAppTarget });
  return true;
}
