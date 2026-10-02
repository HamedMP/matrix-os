import { ChatSharingButton as SharedButton } from "@matrix-os/ui";
import { useMemo, useRef } from "react";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useDesktopCollaborationApi } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function ChatSharingButton(props: { api: ApiClient; chatId: string; copyText: (value: string) => Promise<void>; onLiveShareStart?: () => void; onLiveShareFailed?: () => void }) {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationId = useConnection((state) => state.organizationId);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const verifiedOrganizationId = organizationStatus === "member" ? organizationId : null;
  const runtimeId = useCollaborationRuntimeId(organizationStatus !== "none" ? props.api : null);
  const onLiveShareStart = useRef(props.onLiveShareStart);
  onLiveShareStart.current = props.onLiveShareStart;
  const onLiveShareFailed = useRef(props.onLiveShareFailed);
  onLiveShareFailed.current = props.onLiveShareFailed;
  const baseCollaborationApi = useDesktopCollaborationApi(platformHost, organizationStatus !== "none");
  const collaborationApi = useMemo(() => {
    if (!baseCollaborationApi) return null;
    return {
      ...baseCollaborationApi,
      async post(path: string, body: unknown) {
        const liveChatShare = /^\/api\/collaboration\/runtimes\/[^/?]+\/scopes$/.test(path)
          && body !== null && typeof body === "object" && Reflect.get(body, "kind") === "chat";
        if (liveChatShare) {
          // The owner may have a revealed value on screen. Clear it before the
          // share request can commit, rather than waiting for its response.
          onLiveShareStart.current?.();
        }
        try {
          return await baseCollaborationApi.post(path, body);
        } catch (error) {
          if (liveChatShare) onLiveShareFailed.current?.();
          throw error;
        }
      },
    };
  }, [baseCollaborationApi]);
  return <SharedButton key={verifiedOrganizationId ?? organizationStatus} {...props} collaborationEnabled={runtimeId !== null}
    collaborationApi={collaborationApi ?? undefined} runtimeId={runtimeId} organizationId={verifiedOrganizationId}
    handle={handle} runtimeSlot={runtimeSlot} platformHost={import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost} />;
}
