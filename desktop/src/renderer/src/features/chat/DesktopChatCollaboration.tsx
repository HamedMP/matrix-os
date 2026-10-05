import { ChatCollaboration, type ChatCollaborationView } from "@matrix-os/ui";
import { X } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useState } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { Dialog } from "../../design/primitives";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

const COLLABORATION_LAYERS = {
  dialog: DESKTOP_Z_INDEX.dialog,
  popover: DESKTOP_Z_INDEX.popover,
};

export default function DesktopChatCollaboration({
  hideAcceptedProjects = false,
  onOpenResource,
}: {
  hideAcceptedProjects?: boolean;
  onOpenResource?: () => void;
} = {}) {
  const actorId = useConnection((state) => state.userId);
  const platformHost = useConnection((state) => state.platformHost);
  const api = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const [view, setView] = useState<ChatCollaborationView>({ kind: "home" });
  const openTab = useTabs((state) => state.openTab);
  useEffect(() => () => {
    if (api) releaseDesktopCollaborationApi(api);
  }, [api]);
  if (!actorId || !api) return <div role="alert" className="m-auto max-w-lg rounded-xl border p-8 text-center">
    Shared Chats are unavailable. Reconnect your Matrix account and try again.
  </div>;
  return <div className="relative flex min-h-0 flex-1 flex-col">
    {view.kind !== "home" ? <button type="button" className="absolute left-4 top-3 z-10 rounded-lg border bg-[var(--bg-app)] px-3 py-1.5 text-xs"
      onClick={() => setView({ kind: "home" })}>Back to Shared with me</button> : null}
    <ChatCollaboration view={view} api={api} actorId={actorId} layers={COLLABORATION_LAYERS}
      openInvitation={(invitationId) => setView({ kind: "invitation", invitationId })}
      openChat={(scopeId, chatId, title) => {
        openTab({
          kind: "chat",
          title: title ?? "Shared Chat",
          chatTitle: title ?? "Shared Chat",
          chatView: "conversation",
          ...(chatId ? { chatId } : {}),
          sharedScopeId: scopeId,
          closable: false,
        });
        onOpenResource?.();
      }}
      openTerminal={(scopeId) => {
        openTab({
          kind: "terminal",
          title: "Shared Terminal",
          sessionName: `shared:${scopeId}`,
          sharedScopeId: scopeId,
        });
        onOpenResource?.();
      }}
      openProject={(scopeId) => {
        if (hideAcceptedProjects) onOpenResource?.();
        else setView({ kind: "project", scopeId });
      }}
      hideAcceptedProjects={hideAcceptedProjects} />
  </div>;
}

/** Shared discovery belongs to Chat chrome; it is not an independent desktop app surface. */
export function DesktopSharedWithMeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return <Dialog open={open} onClose={onClose} width={760} title="Shared with me" placement="center">
    {open ? <div className="relative flex h-[min(720px,calc(100vh-48px))] min-h-0 flex-col overflow-hidden">
      <button type="button" aria-label="Close Shared with me"
        className="absolute right-4 top-4 z-10 grid size-8 place-items-center rounded-lg outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        onClick={onClose}>
        <X size={16} aria-hidden />
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <DesktopChatCollaboration hideAcceptedProjects onOpenResource={onClose} />
      </div>
    </div> : null}
  </Dialog>;
}
