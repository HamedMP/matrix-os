import type {
  AgentProviderSummary,
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import { useCallback } from "react";
import { toast } from "sonner";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { executeProviderSetupAction } from "../coding-agents/provider-setup-terminal";
import { findProviderForSetupAction } from "../coding-agents/provider-readiness";

const SETUP_ERROR = "Could not open provider setup. Open Providers settings to continue.";

export function useProviderSetup(
  providers: AgentProviderSummary[],
  onRefresh?: () => Promise<void>,
) {
  const api = useConnection((state) => state.api);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);

  return useCallback(async (
    _instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => {
    if (action.kind === "open_settings") {
      requestSettingsSection("providers");
      openTab({ kind: "settings", title: "Settings" });
      return;
    }
    const provider = findProviderForSetupAction(providers, action);
    const opened = provider
      ? await executeProviderSetupAction({ provider, action, api, openTab, requestSettingsSection })
      : false;
    if (!opened) {
      toast.error(SETUP_ERROR);
      return;
    }
    await onRefresh?.();
  }, [api, onRefresh, openTab, providers, requestSettingsSection]);
}
