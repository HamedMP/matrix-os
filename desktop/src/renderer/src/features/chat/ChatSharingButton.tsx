import { ChatSharingButton as SharedButton } from "@matrix-os/ui";
import { useMemo, useRef } from "react";
import type { ApiClient } from "../../lib/api";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function ChatSharingButton(props: { api: ApiClient; chatId: string; copyText: (value: string) => Promise<void>; onLiveShareStart?: () => void; onLiveShareFailed?: () => void }) {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeId = useCollaborationRuntimeId(props.api);
  const onLiveShareStart = useRef(props.onLiveShareStart);
  onLiveShareStart.current = props.onLiveShareStart;
  const onLiveShareFailed = useRef(props.onLiveShareFailed);
  onLiveShareFailed.current = props.onLiveShareFailed;
  const collaborationApi = useMemo(() => {
    const base = createDesktopCollaborationApi(platformHost);
    if (!base) return null;
    return {
      ...base,
      async post(path: string, body: unknown) {
        const liveChatShare = /^\/api\/collaboration\/runtimes\/[^/?]+\/scopes$/.test(path)
          && body !== null && typeof body === "object" && Reflect.get(body, "kind") === "chat";
        if (liveChatShare) {
          // The owner may have a revealed value on screen. Clear it before the
          // share request can commit, rather than waiting for its response.
          onLiveShareStart.current?.();
        }
        try {
          return await base.post(path, body);
        } catch (error) {
          if (liveChatShare) onLiveShareFailed.current?.();
          throw error;
        }
      },
    };
  }, [platformHost]);
  return <DesktopCollaborationOrganization>{(organizationId) => <SharedButton {...props} collaborationEnabled={runtimeId !== null}
    collaborationApi={collaborationApi ?? undefined} runtimeId={runtimeId} organizationId={organizationId}
    handle={handle} runtimeSlot={runtimeSlot} platformHost={import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost} />}</DesktopCollaborationOrganization>;
}
