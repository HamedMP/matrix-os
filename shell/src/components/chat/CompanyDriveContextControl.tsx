"use client";
import { CompanyDriveContextPicker } from "@matrix-os/ui";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useShellCollaborationApi } from "@/lib/collaboration-organization";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
export function CompanyDriveContextControl({ resources, onSelect, enabled, query, identity }: {
    resources: CanonicalChatResourceReference[];
    onSelect(reference: CanonicalChatResourceReference): void;
    enabled: boolean;
    query: string | null;
    identity: string;
}) {
    const origin = useBrowserOrigin();
    const { status: organizationStatus } = useCollaborationOrganization();
    const api = useShellCollaborationApi(origin, organizationStatus !== "none", identity);
    if (organizationStatus === "none") return null;
    return <CompanyDriveContextPicker api={api} resources={resources} enabled={enabled} mentionQuery={query} onSelect={onSelect}/>;
}
