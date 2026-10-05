import { useEffect, useMemo } from "react";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { CompanyDriveContextPicker } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
export function CompanyDriveContextControl({ resources, onSelect, enabled, botContext = false, query, disabled }: {
    resources: CanonicalChatResourceReference[];
    onSelect(reference: CanonicalChatResourceReference): void;
    enabled: boolean;
    botContext?: boolean;
    query: string | null;
    disabled: boolean;
}) {
    const host = useConnection(state => state.platformHost), slot = useConnection(state => state.runtimeSlot), generation = useConnection(state => state.authGeneration);
    const api = useMemo(() => createDesktopCollaborationApi(host), [host, slot, generation]);
    useEffect(() => () => { if (api)
        releaseDesktopCollaborationApi(api); }, [api]);
    return <CompanyDriveContextPicker api={api} resources={resources} onSelect={onSelect} enabled={enabled} botContext={botContext} mentionQuery={query} disabled={disabled}/>;
}
