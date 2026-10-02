import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { CompanyDriveContextPicker } from "@matrix-os/ui";
import { useConnection } from "../../stores/connection";
import { useDesktopCollaborationApi } from "../collaboration/DesktopCollaborationOrganization";
export function CompanyDriveContextControl({ resources, onSelect, enabled, query, disabled }: {
    resources: CanonicalChatResourceReference[];
    onSelect(reference: CanonicalChatResourceReference): void;
    enabled: boolean;
    query: string | null;
    disabled: boolean;
}) {
    const host = useConnection(state => state.platformHost), slot = useConnection(state => state.runtimeSlot), generation = useConnection(state => state.authGeneration);
    const organizationStatus = useConnection(state => state.organizationStatus);
    const api = useDesktopCollaborationApi(host, organizationStatus !== "none", `${host}\0${slot}\0${generation}`);
    if (organizationStatus === "none") return null;
    return <CompanyDriveContextPicker api={api} resources={resources} onSelect={onSelect} enabled={enabled} mentionQuery={query} disabled={disabled}/>;
}
