import { useEffect } from "react";
import type { StartAgentChat } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { applicableDesktopCompanyDriveDraft, desktopDriveDraftIdentity, useDesktopCompanyDriveChatDraft } from "../../stores/company-drive-chat-draft";
/** Only the active target Chat surface consumes a Files intent, once in the same runtime identity. */
export function useCompanyDriveChatHandoff(active: boolean, tabId: string | undefined, startDraft: StartAgentChat): void {
    const identity = useConnection(desktopDriveDraftIdentity);
    const request = useDesktopCompanyDriveChatDraft(state => state.request);
    useEffect(() => {
        if (!active || !request || useDesktopCompanyDriveChatDraft.getState().request !== request)
            return;
        if (request.identity !== identity || Date.now() - request.createdAt > 10 * 60000) {
            useDesktopCompanyDriveChatDraft.getState().consume(request);
            return;
        }
        if (!applicableDesktopCompanyDriveDraft(request, identity, tabId))
            return;
        useDesktopCompanyDriveChatDraft.getState().consume(request);
        startDraft("", [request.reference]);
    }, [active, identity, request, tabId, startDraft]);
}
