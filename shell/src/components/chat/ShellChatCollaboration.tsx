"use client";

import { useAuth } from "@clerk/nextjs";
import { ChatCollaboration, type ChatCollaborationView } from "@matrix-os/ui";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";
const COLLABORATION_LAYERS = { dialog: SHELL_Z_INDEX.appDialog, popover: SHELL_Z_INDEX.popover };

export function ShellChatCollaboration({
  view,
  onOpenChat,
  onSessionMetadata,
  headerContainer,
}: {
  view: ChatCollaborationView;
  onOpenChat?: (scopeId: string) => void;
  onSessionMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
  headerContainer?: HTMLElement | null;
}) {
  const { isLoaded, userId } = useAuth();
  const browserOrigin = useBrowserOrigin();
  const router = useRouter();
  const api = useMemo(
    () => browserOrigin ? createShellCollaborationApi(browserOrigin) : null,
    [browserOrigin],
  );
  const actorId = userId ?? (e2eBypass ? "user_e2e" : null);

  if ((!isLoaded && !e2eBypass) || !browserOrigin) {
    return <p role="status" className="p-8">Loading shared Chat…</p>;
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
      openProject={(scopeId) => router.push(`/shared/project/${encodeURIComponent(scopeId)}`)}
    />
  </div>;
}
