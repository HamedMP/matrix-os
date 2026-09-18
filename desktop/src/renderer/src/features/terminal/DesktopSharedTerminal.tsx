import { ChatCollaboration } from "@matrix-os/ui";
import { useMemo } from "react";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

export function DesktopSharedTerminal({ scopeId }: { scopeId: string }) {
  const actorId = useConnection((state) => state.userId);
  const platformHost = useConnection((state) => state.platformHost);
  const api = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  if (!actorId || !api) return <div role="alert" className="m-auto max-w-lg rounded-xl border p-8 text-center">
    Shared terminal is unavailable. Reconnect your Matrix account and try again.
  </div>;
  return <div data-slot="native-shared-terminal" className="flex min-h-0 flex-1 overflow-hidden bg-[#101218]">
    <ChatCollaboration view={{ kind: "terminal", scopeId }} api={api} actorId={actorId} />
  </div>;
}
