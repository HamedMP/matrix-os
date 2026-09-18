"use client";

import { useAuth } from "@clerk/nextjs";
import { ChatCollaboration, type ChatCollaborationView } from "@matrix-os/ui";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi } from "@/lib/collaboration";

const e2eBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1";

export function ShellChatCollaboration({
  view,
  onOpenChat,
  onSessionMetadata,
}: {
  view: ChatCollaborationView;
  onOpenChat?: (scopeId: string) => void;
  onSessionMetadata?: (metadata: { title: string; role: "owner" | "editor" | "viewer" }) => void;
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
      onChatMetadata={onSessionMetadata}
      openInvitation={(invitationId) => router.push(`/shared/invitations/${encodeURIComponent(invitationId)}`)}
      openChat={(scopeId) => {
        onOpenChat?.(scopeId);
      }}
      openTerminal={(scopeId) => router.push(`/shared/terminal/${encodeURIComponent(scopeId)}`)}
      openProject={(scopeId) => router.push(`/shared/project/${encodeURIComponent(scopeId)}`)}
    />
  </div>;
}
