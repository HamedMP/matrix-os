import { ChatCollaboration, type ChatCollaborationView } from "@matrix-os/ui";
import { useMemo, useState } from "react";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

export default function DesktopChatCollaboration() {
  const actorId = useConnection((state) => state.userId);
  const platformHost = useConnection((state) => state.platformHost);
  const api = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const [view, setView] = useState<ChatCollaborationView>({ kind: "home" });
  const openTab = useTabs((state) => state.openTab);
  if (!actorId || !api) return <div role="alert" className="m-auto max-w-lg rounded-xl border p-8 text-center">
    Shared Chats are unavailable. Reconnect your Matrix account and try again.
  </div>;
  return <div className="relative flex min-h-0 flex-1 flex-col">
    {view.kind !== "home" ? <button type="button" className="absolute left-4 top-3 z-10 rounded-lg border bg-[var(--bg-app)] px-3 py-1.5 text-xs"
      onClick={() => setView({ kind: "home" })}>Back to Shared with me</button> : null}
    <ChatCollaboration view={view} api={api} actorId={actorId}
      openInvitation={(invitationId) => setView({ kind: "invitation", invitationId })}
      openChat={(scopeId, chatId, title) => openTab({
        kind: "chat",
        title: title ?? "Shared Chat",
        chatTitle: title ?? "Shared Chat",
        chatView: "conversation",
        ...(chatId ? { chatId } : {}),
        sharedScopeId: scopeId,
        closable: false,
      })}
      openTerminal={(scopeId) => openTab({
        kind: "terminal",
        title: "Shared Terminal",
        sessionName: `shared:${scopeId}`,
        sharedScopeId: scopeId,
      })}
      openProject={(scopeId) => setView({ kind: "project", scopeId })} />
  </div>;
}
