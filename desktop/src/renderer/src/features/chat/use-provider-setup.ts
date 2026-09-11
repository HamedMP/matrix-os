import type {
  AgentProviderSummary,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import { useCallback } from "react";
import { toast } from "sonner";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import {
  executeCatalogProviderSetupAction,
  executeProviderSetupAction,
} from "../coding-agents/provider-setup-terminal";
import { findProviderForSetupAction } from "../coding-agents/provider-readiness";

const SETUP_ERROR = "Could not open setup. Open Settings to continue.";

export function useProviderSetup(
  providers: AgentProviderSummary[],
  onRefresh?: () => Promise<void>,
  apiOverride?: ApiClient | null,
) {
  const connectionApi = useConnection((state) => state.api);
  const api = apiOverride === undefined ? connectionApi : apiOverride;
  const openTab = useTabs((state) => state.openTab);

  return useCallback(async (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => {
    const provider = findProviderForSetupAction(providers, action);
    const opened = provider
      ? await executeProviderSetupAction({ provider, action, api, openTab })
      : await executeCatalogProviderSetupAction({ instance, action, api, openTab });
    if (!opened) {
      toast.error(SETUP_ERROR);
      return;
    }
    await onRefresh?.();
  }, [api, onRefresh, openTab, providers]);
}
