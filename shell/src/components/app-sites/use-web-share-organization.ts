"use client";
import { useMemo } from "react";
import { useShareOrganization } from "@matrix-os/ui/share";
import { shellApi } from "../../api/http";
import { useCollaborationOrganization } from "../../lib/collaboration-organization-state";
import { sharedAppDisplayHint, sharedAppOpenPath } from "@matrix-os/contracts";
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
    // Same path as Create app: a new chat with the prompt in the composer,
    // sent by the owner with their normal provider and model choices.
    startChat: async (prompt) => {
      if (!chat) return false;
      openChat();
      await chat.newChat();
      chat.requestComposerDraft(prompt, { merge: true });
      return true;
    },
    // Web hand-off page that opens the desktop app on /shared/app/<scopeId> (phase 4).
    orgLink: (share, hints) => typeof window === "undefined" ? null
      : new URL(sharedAppOpenPath({ scopeId: share.scopeId, expectedBuildId: share.build.buildId, expectedShareRevision: share.shareRevision, app: sharedAppDisplayHint(hints.app), org: sharedAppDisplayHint(hints.org) }), window.location.origin).toString(),
  });
}
