import { createOrganizationManagementActions, type OrganizationManagementActions } from "@matrix-os/ui";
import { useCallback, useState } from "react";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

export function useDesktopOrganizationActions(organizationId: string | null, onChanged: () => void) {
  const platformHost = useConnection((state) => state.platformHost);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: (actions: OrganizationManagementActions) => Promise<void>): Promise<boolean> => {
    if (!organizationId || busy) return false;
    const api = createDesktopCollaborationApi(platformHost);
    if (!api) {
      setError("Organization settings are unavailable. Try again.");
      return false;
    }
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
      releaseDesktopCollaborationApi(api);
      setBusy(false);
    }
  }, [busy, onChanged, organizationId, platformHost]);

  return { run, busy, error, clearError: () => setError(null) };
}
