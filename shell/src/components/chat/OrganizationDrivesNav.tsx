"use client";
import { useAuth } from "@clerk/nextjs";
import { getGatewayUrl } from "@/lib/gateway";
import { useEffect, useMemo } from "react";
import { OrganizationDrivesNavigation } from "@matrix-os/ui";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useWindowManager } from "@/hooks/useWindowManager";
import { createShellCollaborationApi } from "@/lib/collaboration";
import { organizationDriveNavigationIdentity, useOrganizationDriveNavigation } from "@/stores/organization-drive-navigation";
export function OrganizationDrivesNav() {
  const {userId, sessionId} = useAuth();
  const identity = organizationDriveNavigationIdentity(userId, sessionId, getGatewayUrl());
  const origin = useBrowserOrigin();
  const api = useMemo(() => origin && userId ? createShellCollaborationApi(origin) : null, [origin, userId, identity]);
  useEffect(() => () => api?.direct?.close(), [api]);
  return <OrganizationDrivesNavigation api={api} onOpen={drive => {
    useOrganizationDriveNavigation.getState().open(drive.scopeId, identity);
    const manager = useWindowManager.getState();
    const existing = manager.windows.find(window => window.path === "__file-browser__");
    if (existing) {manager.restoreWindow(existing.id); manager.focusWindow(existing.id);}
    else manager.openWindow("Files", "__file-browser__", 0);
  }}/>;
}
