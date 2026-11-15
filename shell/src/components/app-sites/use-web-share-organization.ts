"use client";
import { useMemo } from "react";
import { useShareOrganization } from "@matrix-os/ui/share";
import { shellApi } from "../../api/http";
import { useCollaborationOrganization } from "../../lib/collaboration-organization-state";
import { sharedAppDeepLink } from "../../lib/shared-app-target";
import { useChatContext } from "../../stores/chat-context";
import { useWindowManager } from "../../hooks/useWindowManager";
import { useShellOrganizationsFor } from "../organization/useShellOrganizations";
import { useOwnerCollaborationParticipant } from "../../lib/owner-collaboration-participant";

/** Web Desktop / Web Canvas wiring for the shared Organization tab (spec 2693 phase 2). */
export function useWebShareOrganization(appSlug: string, appName: string) {
  const participant = useOwnerCollaborationParticipant();
  const listing = useShellOrganizationsFor(participant?.actorId ?? null);
  const active = useCollaborationOrganization();
  const chat = useChatContext();
  const organizations = useMemo(() => listing.state === "loaded"
    ? listing.organizations.map(({ organizationId, name, memberCount }) => ({ organizationId, name, memberCount }))
    : listing.state === "failed" ? [] : null, [listing]);
  const openChat = () => useWindowManager.getState().openWindow("Chat", "__chat__", 0);
  return useShareOrganization({
    appSlug, appName, organizations,
    preferredOrganizationId: active.status === "member" ? active.organizationId : null,
    collaborationApi: shellApi,
    fileApi: shellApi,
    openChat,
    startChat: async (prompt) => {
      if (!chat) return false;
      openChat();
      await chat.newChat();
      const sent = await chat.submitMessage(prompt);
      return sent !== false;
    },
    orgLink: (share) => typeof window === "undefined" ? null
      : new URL(sharedAppDeepLink({ scopeId: share.scopeId, buildId: share.build.buildId, shareRevision: share.shareRevision }), window.location.origin).toString(),
  });
}
