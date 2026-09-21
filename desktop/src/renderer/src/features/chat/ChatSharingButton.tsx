import { ChatSharingButton as SharedButton } from "@matrix-os/ui";
import { useMemo } from "react";
import type { ApiClient } from "../../lib/api";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function ChatSharingButton(props: { api: ApiClient; chatId: string; copyText: (value: string) => Promise<void> }) {
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeId = useCollaborationRuntimeId(props.api);
  const collaborationApi = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  return <DesktopCollaborationOrganization>{(organizationId) => <SharedButton {...props} collaborationEnabled={runtimeId !== null}
    collaborationApi={collaborationApi ?? undefined} runtimeId={runtimeId} organizationId={organizationId}
    handle={handle} runtimeSlot={runtimeSlot} platformHost={import.meta.env.VITE_CHAT_SHARE_ORIGIN || platformHost} />}</DesktopCollaborationOrganization>;
}
