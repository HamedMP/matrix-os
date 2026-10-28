import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useProviderSettingsController, type GetStartedAgentLoginPort, type ProviderSettingsMutationIntent } from "@matrix-os/ui";
import "@matrix-os/ui/agents-providers.css";
import { useCallback, useMemo, type ReactNode } from "react";
import type { ApiClient } from "../../lib/api";
import { useConnection } from "../../stores/connection";
import { invalidateDesktopProviderCatalog } from "../chat/provider-catalog-invalidation";
import { createDesktopProviderSettingsTransport, desktopProviderIdentityKey } from "../settings/provider-settings-desktop-adapter";
import { createDesktopProviderWorkflowClient, openDesktopProviderWorkflowAuthorization } from "../settings/provider-workflow-transport";

type PortChildren = (port: GetStartedAgentLoginPort) => ReactNode;

function ConnectedAgentLogin({ children, api, runtimeSlot, identityKey }: { children: PortChildren; api: ApiClient; runtimeSlot: string; identityKey: string }) {
  const runtimeApi = useMemo(() => api.forRuntime(runtimeSlot), [api, runtimeSlot]);
  const transport = useMemo(() => createDesktopProviderSettingsTransport(runtimeApi), [runtimeApi]);
  const isIdentityCurrent = useCallback(() => desktopProviderIdentityKey(useConnection.getState()) === identityKey, [identityKey]);
  // Chat and the onboarding widget read the same catalog, so a new sign-in reaches them too.
  const onCatalogChanged = useCallback((intent?: ProviderSettingsMutationIntent, previous?: ProviderSettingsSnapshot) => {
    if (isIdentityCurrent()) invalidateDesktopProviderCatalog(identityKey, intent, previous);
  }, [identityKey, isIdentityCurrent]);
  const controller = useProviderSettingsController({ identityKey, transport, onCatalogChanged });
  const workflowClient = useMemo(() => createDesktopProviderWorkflowClient(runtimeApi, isIdentityCurrent), [runtimeApi, isIdentityCurrent]);
  const { snapshot, error, refresh } = controller;
  const port = useMemo<GetStartedAgentLoginPort>(() => ({
    snapshot,
    failed: snapshot === null && error !== null,
    workflowClient,
    refresh: () => refresh(),
    openAuthorizationUrl: (url) => {
      if (isIdentityCurrent()) void openDesktopProviderWorkflowAuthorization(url);
    },
  }), [snapshot, error, workflowClient, refresh, isIdentityCurrent]);
  return <>{children(port)}</>;
}

/** Electron Desktop: one Settings > Agents & providers port for the coding agents screen. */
export function DesktopGetStartedAgentLogin({ children }: { children: PortChildren }) {
  const status = useConnection((state) => state.status);
  const handle = useConnection((state) => state.handle);
  const userId = useConnection((state) => state.userId);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const api = useConnection((state) => state.api);
  if (status !== "signed-in" || api === null) return <p className="mxo-muted">You can sign in to Claude Code or Codex later in Settings &gt; Agents &amp; providers.</p>;
  const identityKey = desktopProviderIdentityKey({ status, handle, userId, platformHost, runtimeSlot, authGeneration });
  return <ConnectedAgentLogin key={identityKey} api={api} runtimeSlot={runtimeSlot} identityKey={identityKey}>{children}</ConnectedAgentLogin>;
}
