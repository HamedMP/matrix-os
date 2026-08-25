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

const SETUP_ERROR = "Could not open setup. Open Settings to continue.";

function settingsSectionForInstance(
  instance: CanonicalProviderInstanceDescriptor,
): "agent" | "providers" {
  return instance.driverKind === "hermes" || instance.driverKind === "openclaw"
    ? "agent"
    : "providers";
}

export function useProviderSetup(
  providers: AgentProviderSummary[],
  onRefresh?: () => Promise<void>,
) {
  const api = useConnection((state) => state.api);
  const openTab = useTabs((state) => state.openTab);
  const requestSettingsSection = useUi((state) => state.requestSettingsSection);

  return useCallback(async (
    instance: CanonicalProviderInstanceDescriptor,
    action: CanonicalProviderSetupAction,
  ) => {
    if (action.kind === "open_settings") {
      requestSettingsSection(settingsSectionForInstance(instance));
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
