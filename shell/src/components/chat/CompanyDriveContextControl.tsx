"use client";
import { useEffect, useMemo } from "react";
import { CompanyDriveContextPicker } from "@matrix-os/ui";
import type { CanonicalChatResourceReference } from "@matrix-os/contracts";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi, releaseShellCollaborationApi } from "@/lib/collaboration";
export function CompanyDriveContextControl({ resources, onSelect, enabled, botContext = false, query, identity }: {
    resources: CanonicalChatResourceReference[];
    onSelect(reference: CanonicalChatResourceReference): void;
    enabled: boolean;
    botContext?: boolean;
    query: string | null;
    identity: string;
}) {
    const origin = useBrowserOrigin();
    const api = useMemo(() => origin ? createShellCollaborationApi(origin) : null, [origin, identity]);
    useEffect(() => () => { if (api)
        releaseShellCollaborationApi(api); }, [api]);
    return <CompanyDriveContextPicker api={api} resources={resources} enabled={enabled} botContext={botContext} mentionQuery={query} onSelect={onSelect}/>;
}
