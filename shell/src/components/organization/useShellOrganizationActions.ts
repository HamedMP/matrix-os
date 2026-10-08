"use client";

import { createOrganizationManagementActions, type OrganizationManagementActions } from "@matrix-os/ui";
import { useCallback, useState } from "react";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { createShellCollaborationApi, releaseShellCollaborationApi } from "@/lib/collaboration";

export function useShellOrganizationActions(organizationId: string | null, onChanged: () => void) {
  const origin = useBrowserOrigin();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: (actions: OrganizationManagementActions) => Promise<void>): Promise<boolean> => {
    if (!origin || !organizationId || busy) return false;
    const api = createShellCollaborationApi(origin);
    setBusy(true);
    setError(null);
    try {
      await action(createOrganizationManagementActions(api, organizationId));
      onChanged();
      return true;
    } catch (failure: unknown) {
      console.warn("[organization-management] update failed", failure instanceof Error ? failure.name : "UnknownError");
      setError("That change couldn’t be saved. Try again.");
      return false;
    } finally {
      releaseShellCollaborationApi(api);
      setBusy(false);
    }
  }, [busy, onChanged, organizationId, origin]);

  return { run, busy, error };
}
