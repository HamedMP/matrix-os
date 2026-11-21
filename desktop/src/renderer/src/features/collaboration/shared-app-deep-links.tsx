import { useEffect } from "react";
import { create } from "zustand";
import { toast } from "sonner";
import type { SharedAppDeepLink } from "../../../../shared/shared-app-deep-link-ipc";
import { invoke, onEvent } from "../../lib/operator";
import { useTabs } from "../../stores/tabs";
import { useConnection } from "../../stores/connection";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { lookupSharedApp, sharedAppDisplayName } from "@matrix-os/ui/collaborative-app-sharing";
import { useDesktopCollaborationApi } from "./DesktopCollaborationOrganization";

interface PendingSharedAppLink { link: SharedAppDeepLink | null; set(link: SharedAppDeepLink | null): void }
/** Latest org link to open (spec 2693 phase 4); one at a time, newest wins. */
export const usePendingSharedAppLink = create<PendingSharedAppLink>((set) => ({ link: null, set: (link) => set({ link }) }));

/** Listens for org-link deep links and takes one that arrived before the renderer was ready. */
export function wireSharedAppDeepLinks(): () => void {
  const dispose = onEvent("deeplink:shared-app", (link) => usePendingSharedAppLink.getState().set(link));
  void invoke("deeplink:take-shared-app", {}).then(({ link }) => {
    if (link) usePendingSharedAppLink.getState().set(link);
  }).catch((error: unknown) => {
    console.warn("[shared-app-link] pending link unavailable", error instanceof Error ? error.name : "UnknownError");
  });
  return dispose;
}

export const NOT_SHARED_WITH_YOU = "This app isn’t shared with you. Only members of its organization can open it.";
export const OUTDATED_LINK = "This link is out of date because sharing was restarted. Open the app from your launcher or ask for a new link.";

/**
 * Opens a pending org link once signed in. The platform's single-scope lookup
 * is the gate: a scope that is not shared with the member through a current
 * organization is never opened, so the link alone grants nothing. One request
 * replaces paging the member's whole directory (ENG-490). The platform
 * re-checks membership when the app launches.
 */
export function SharedAppDeepLinkOpener() {
  const link = usePendingSharedAppLink((state) => state.link);
  const host = useConnection((state) => state.platformHost);
  const actorId = useConnection((state) => state.userId);
  const organizationId = useConnection((state) => state.organizationId);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const generation = useConnection((state) => state.authGeneration);
  const inNoOrganization = organizationStatus === "none";
  const identity = `${host}:${actorId ?? ""}:${organizationId ?? ""}:${generation ?? ""}`;
  const api = useDesktopCollaborationApi(host, link !== null && !!actorId && !inNoOrganization, identity);
  useEffect(() => {
    if (link && inNoOrganization) { usePendingSharedAppLink.getState().set(null); toast.error(NOT_SHARED_WITH_YOU); return; }
    if (!link || !api) return;
    let active = true;
    // Only the link this lookup was for may be consumed; a newer link wins.
    const settle = () => {
      if (!active || usePendingSharedAppLink.getState().link !== link) return false;
      usePendingSharedAppLink.getState().set(null);
      return true;
    };
    void lookupSharedApp(api, link.scopeId).then((target) => {
      if (!settle()) return;
      if (!target) { toast.error(NOT_SHARED_WITH_YOU); return; }
      // Honour the link's expectations, like the web /shared/app route.
      if ((link.expectedShareRevision && link.expectedShareRevision !== target.shareRevision)
        || (link.expectedBuildId && link.expectedBuildId !== target.buildId)) { toast.error(OUTDATED_LINK); return; }
      const tabId = useTabs.getState().openTab({ kind: "app", slug: target.appId, title: sharedAppDisplayName(target.appId), sharedAppTarget: target });
      useDesktopSurfaces.getState().activateSurface(tabId);
    }).catch((error: unknown) => {
      console.warn("[shared-app-link] lookup unavailable", error instanceof Error ? error.name : "UnknownError");
      if (settle()) toast.error("Couldn’t open the shared app. Try again.");
    });
    return () => { active = false; };
  }, [link, inNoOrganization, api]);
  return null;
}
