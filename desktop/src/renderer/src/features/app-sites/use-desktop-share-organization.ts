import { useMemo } from "react";
import { sharedAppShareOpenPath } from "@matrix-os/contracts";
import { useShareOrganization } from "@matrix-os/ui/share";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { openDesktopTextChatDraft } from "../../stores/company-drive-chat-draft";
import { useDesktopSurfaces } from "../../stores/desktop-surfaces";
import { openChatIndex } from "../mission-control/navigation-roots";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";

/** Chats list, where the owner finds the setup chat they started. */
const openChats = () => { useDesktopSurfaces.getState().activateSurface(openChatIndex()); };

/** Electron Desktop wiring for the shared Organization tab (spec 2693 phase 2). */
export function useDesktopShareOrganization({ appSlug, appName, api, buildEpoch, allowNewSharing = true }: {
  appSlug: string; appName: string; api: ApiClient | null; buildEpoch: number; allowNewSharing?: boolean;
}) {
  const listing = useDesktopOrganizations();
  const activeOrganizationId = useConnection((state) => state.organizationStatus === "member" ? state.organizationId : null);
  const platformHost = useConnection((state) => state.platformHost);
  const organizations = useMemo(() => listing.state === "loaded"
    ? listing.organizations.map(({ organizationId, name, memberCount }) => ({ organizationId, name, memberCount }))
    : listing.state === "failed" ? [] : null, [listing]);
  return useShareOrganization({
    appSlug, appName, organizations, buildEpoch, allowNewSharing,
    preferredOrganizationId: activeOrganizationId,
    collaborationApi: api,
    fileApi: api,
    openChat: openChats,
    // Prefills a new draft in the visible Chat surface; the owner sends it.
    startChat: async (prompt) => openDesktopTextChatDraft(prompt),
    orgLink: (share, hints) => {
      const origin = import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost;
      if (!origin) return null;
      return new URL(sharedAppShareOpenPath(share, hints), origin).toString();
    },
  });
}
