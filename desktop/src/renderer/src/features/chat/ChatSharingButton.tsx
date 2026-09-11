import { ChatSharingButton as SharedButton } from "@matrix-os/ui";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { collaborationRuntimeIdFromSystemInfo, createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

export function ChatSharingButton(props: { api: ApiClient; chatId: string; copyText: (value: string) => Promise<void> }) {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const collaborationApi = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const value = await props.api.get("/api/system/info", { maxBytes: 64 * 1024 });
        if (active) setRuntimeId(collaborationRuntimeIdFromSystemInfo(value));
      } catch (failure: unknown) {
        console.warn("[chat-collaboration] runtime identity unavailable", failure instanceof Error ? failure.name : "UnknownError");
      }
    })();
    return () => { active = false; };
  }, [props.api]);
  return <SharedButton {...props} collaborationApi={collaborationApi ?? undefined} runtimeId={runtimeId}
    handle={handle} runtimeSlot={runtimeSlot} platformHost={import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost} />;
}
