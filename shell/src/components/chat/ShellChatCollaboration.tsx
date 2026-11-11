"use client";

import { useAuth } from "@clerk/nextjs";
import { ChatCollaboration, type ChatCollaborationView } from "@matrix-os/ui";
import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
import { useNativeCollaborationActor } from "@/lib/native-collaboration-identity";
import { sharedAppDeepLink } from "@/lib/shared-app-target";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const COLLABORATION_LAYERS = { dialog: SHELL_Z_INDEX.appDialog, popover: SHELL_Z_INDEX.popover };

export function ShellChatCollaboration({
  ...props
}: {
  view: ChatCollaborationView;
  onOpenChat?: (scopeId: string) => void;
  /** Opens a shared project in this Chats app; never a standalone page. */
  onOpenProject?: (scopeId: string) => void;
  onOpenApp?: (target: CollaborativeAppDirectoryItem) => void;
  onSessionMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  headerContainer?: HTMLElement | null;
}) {
  const nativeActorId = useNativeCollaborationActor();
  return nativeActorId
    ? <ShellChatCollaborationContent {...props} actorId={nativeActorId} nativeSession />
    : <ClerkShellChatCollaboration {...props} />;
}

function ClerkShellChatCollaboration(props: {
  view: ChatCollaborationView;
  onOpenChat?: (scopeId: string) => void;
  onOpenProject?: (scopeId: string) => void;
  onOpenApp?: (target: CollaborativeAppDirectoryItem) => void;
  onSessionMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  headerContainer?: HTMLElement | null;
}) {
  const { isLoaded, userId } = useAuth();
  const actorId = userId ?? (e2eBypass ? "user_e2e" : null);
  if (!isLoaded && !e2eBypass) return <p role="status" className="p-8">Loading shared Chat…</p>;
  return <ShellChatCollaborationContent {...props} actorId={actorId} nativeSession={false} />;
}

function ShellChatCollaborationContent({
  view,
  onOpenChat,
  onOpenProject,
  onOpenApp,
  onSessionMetadata,
  headerContainer,
  actorId,
  nativeSession,
}: {
  view: ChatCollaborationView;
  onOpenChat?: (scopeId: string) => void;
  /** Opens a shared project in this Chats app; never a standalone page. */
  onOpenProject?: (scopeId: string) => void;
  onOpenApp?: (target: CollaborativeAppDirectoryItem) => void;
  onSessionMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  headerContainer?: HTMLElement | null;
  actorId: string | null;
  nativeSession: boolean;
}) {
  const browserOrigin = useBrowserOrigin();
  const { status: organizationStatus } = useCollaborationOrganization();
  const router = useRouter();
  const api = useMemo(
    () => browserOrigin ? createShellCollaborationApi(browserOrigin) : null,
    [browserOrigin],
  );

  if (!browserOrigin) {
    return <p role="status" className="p-8">Loading shared Chat…</p>;
  }
  if (!nativeSession && organizationStatus === "none") {
    return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
      Organization sharing is no longer available for this account.
    </div>;
  }
  if (!actorId || !api) {
    return <div role="alert" className="m-auto max-w-lg rounded-2xl border p-8 text-center">
      Shared Chats require an authenticated Matrix account.
    </div>;
  }

  return <div data-slot="chat-app-collaboration" className="min-h-0 flex-1 overflow-hidden">
    <ChatCollaboration
      view={view}
      api={api}
      actorId={actorId}
      layers={COLLABORATION_LAYERS}
      onChatMetadata={onSessionMetadata}
      headerContainer={headerContainer}
      openInvitation={(invitationId) => router.push(`/shared/invitations/${encodeURIComponent(invitationId)}`)}
      openChat={(scopeId) => {
        onOpenChat?.(scopeId);
      }}
      openTerminal={(scopeId) => router.push(`/shared/terminal/${encodeURIComponent(scopeId)}`)}
      openProject={(scopeId) => {
        onOpenProject?.(scopeId);
      }}
      openApp={(_scopeId, target) => {
        if (onOpenApp) onOpenApp(target);
        else router.push(sharedAppDeepLink(target));
      }}
    />
  </div>;
}
