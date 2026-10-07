import { ChatSharingButton as SharedButton } from "@matrix-os/ui";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useDesktopCollaborationApi } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function ChatSharingButton(props: { api: ApiClient; chatId: string; copyText: (value: string) => Promise<void> }) {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationId = useConnection((state) => state.organizationId);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const verifiedOrganizationId = organizationStatus === "member" ? organizationId : null;
  const collaborationApi = useDesktopCollaborationApi(platformHost, organizationStatus !== "none");
  const runtimeId = useCollaborationRuntimeId(organizationStatus !== "none" ? props.api : null);
  return <SharedButton key={verifiedOrganizationId ?? organizationStatus} {...props}
    handle={handle} runtimeSlot={runtimeSlot}
    platformHost={import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost}
    legacyCollaboration={collaborationApi ? {
      api: collaborationApi,
      runtimeId,
      organizationId: verifiedOrganizationId,
    } : undefined} />;
}
