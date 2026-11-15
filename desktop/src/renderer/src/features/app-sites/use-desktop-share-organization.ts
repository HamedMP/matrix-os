import { useMemo } from "react";
import { sharedAppDisplayHint, sharedAppOpenPath } from "@matrix-os/contracts";
import { useShareOrganization } from "@matrix-os/ui/share";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useHermesChat } from "../../stores/hermes-chat";
import { useTabs } from "../../stores/tabs";
import { useDesktopOrganizations } from "../collaboration/useDesktopOrganizations";

const openChatTab = () => useTabs.getState().openTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false });

/** Electron Desktop wiring for the shared Organization tab (spec 2693 phase 2). */
export function useDesktopShareOrganization({ appSlug, appName, api, buildEpoch }: {
  appSlug: string; appName: string; api: ApiClient | null; buildEpoch: number;
}) {
  const listing = useDesktopOrganizations();
  const activeOrganizationId = useConnection((state) => state.organizationStatus === "member" ? state.organizationId : null);
  const platformHost = useConnection((state) => state.platformHost);
  const organizations = useMemo(() => listing.state === "loaded"
    ? listing.organizations.map(({ organizationId, name, memberCount }) => ({ organizationId, name, memberCount }))
    : listing.state === "failed" ? [] : null, [listing]);
  return useShareOrganization({
    appSlug, appName, organizations, buildEpoch,
    preferredOrganizationId: activeOrganizationId,
    collaborationApi: api,
    fileApi: api,
    openChat: () => { openChatTab(); },
    startChat: async (prompt) => {
      openChatTab();
      const chat = useHermesChat.getState();
      chat.newChat();
      return useHermesChat.getState().send(prompt);
    },
    orgLink: (share, hints) => {
      const origin = import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost;
      if (!origin) return null;
      return new URL(sharedAppOpenPath({ scopeId: share.scopeId, expectedBuildId: share.build.buildId, expectedShareRevision: share.shareRevision, app: sharedAppDisplayHint(hints.app), org: sharedAppDisplayHint(hints.org) }), origin).toString();
    },
  });
}
