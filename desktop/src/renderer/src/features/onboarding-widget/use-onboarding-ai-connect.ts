import type { OnboardingAiConnectPort } from "@matrix-os/ui";
import { useCallback, useMemo } from "react";
import type { ApiClient } from "../../lib/api";
import { desktopProviderIdentityKey } from "../../lib/provider-settings-identity";
import { useConnection } from "../../stores/connection";
import { createDesktopProviderWorkflowClient, openDesktopProviderWorkflowAuthorization } from "../settings/provider-workflow-transport";

/** Desktop transport for the widget's Claude / ChatGPT sign-in. */
export function useDesktopOnboardingAiPort(api: ApiClient | null): OnboardingAiConnectPort | null {
  const identityKey = useConnection((state) => desktopProviderIdentityKey(state));
  const invalidateProviderCatalog = useConnection((state) => state.invalidateProviderCatalog);
  const isIdentityCurrent = useCallback(() => desktopProviderIdentityKey(useConnection.getState()) === identityKey, [identityKey]);
  return useMemo(() => (api ? {
    client: createDesktopProviderWorkflowClient(api, isIdentityCurrent),
    openAuthorization: openDesktopProviderWorkflowAuthorization,
    isIdentityCurrent,
    onConnected: (harnessInstanceId: string) => invalidateProviderCatalog(identityKey, [harnessInstanceId]),
  } : null), [api, identityKey, invalidateProviderCatalog, isIdentityCurrent]);
}
