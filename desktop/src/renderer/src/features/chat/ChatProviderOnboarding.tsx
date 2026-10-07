import { desktopProviderCatalogCache } from "./provider-catalog-coordinator";
import { invalidateDesktopProviderCatalog } from "../chat/provider-catalog-invalidation";
import type { ProviderSettingsMutationIntent } from "@matrix-os/ui";
import type { ProviderSettingsSnapshot } from "@matrix-os/contracts";
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ChatProviderOnboarding as SharedOnboarding } from "@matrix-os/ui";
import "@matrix-os/ui/agents-providers.css";
import type { ProviderConnectionAttempt } from "@matrix-os/contracts";
import { useConnection } from "../../stores/connection";
import type { ApiClient } from "../../lib/api";
import { createDesktopProviderSettingsTransport, desktopProviderIdentityKey, openExistingProviderTerminalSession, openProviderAuthorizationPath } from "../settings/provider-settings-desktop-adapter";

function ConnectedOnboarding({ api, identityKey, runtimeSlot, platformHost, children }: {
  api: ApiClient; identityKey: string; runtimeSlot: string; platformHost: string; children?: ReactNode;
}) {
  const catalogSnapshot = useSyncExternalStore(desktopProviderCatalogCache.subscribe, desktopProviderCatalogCache.getSnapshot);
  const backgroundRefreshKey = catalogSnapshot.identityKey === identityKey ? catalogSnapshot.lastSuccessAt : null;
  const runtimeApi = useMemo(() => api.forRuntime(runtimeSlot), [api, runtimeSlot]);
  const transport = useMemo(() => createDesktopProviderSettingsTransport(runtimeApi), [runtimeApi]);
  const isIdentityCurrent = useCallback(() => desktopProviderIdentityKey(useConnection.getState()) === identityKey, [identityKey]);
  const onCatalogChanged = useCallback((intent?: ProviderSettingsMutationIntent, snapshot?: ProviderSettingsSnapshot) => {
    if (isIdentityCurrent()) invalidateDesktopProviderCatalog(identityKey, intent, snapshot);
  }, [identityKey, isIdentityCurrent]);
  const openAction = useCallback(async (action: ProviderConnectionAttempt["action"]) => {
    if (!isIdentityCurrent()) return false;
    if (action.kind === "open_terminal") return openExistingProviderTerminalSession(runtimeApi, action.terminalSessionId, isIdentityCurrent);
    if (action.kind === "open_browser") return openProviderAuthorizationPath({ authorizationPath: action.authorizationPath, platformHost, runtimeSlot });
    return false;
  }, [isIdentityCurrent, runtimeApi, platformHost, runtimeSlot]);
  return <SharedOnboarding identityKey={identityKey} transport={transport} isIdentityCurrent={isIdentityCurrent}
    onCatalogChanged={onCatalogChanged} openAction={openAction} lifecycleRefresh={false} backgroundRefreshKey={backgroundRefreshKey}>{children}</SharedOnboarding>;
}

export function ChatProviderOnboarding({ children }: { children?: ReactNode }) {
  const status = useConnection((state) => state.status);
  const api = useConnection((state) => state.api);
  const handle = useConnection((state) => state.handle);
  const userId = useConnection((state) => state.userId);
  const platformHost = useConnection((state) => state.platformHost);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const identityKey = desktopProviderIdentityKey({ status, handle, userId, platformHost, runtimeSlot, authGeneration });
  // Without an authenticated runtime, retain Chat's normal connection recovery.
  if (status !== "signed-in" || !api) return <>{children}</>;
  return <ConnectedOnboarding key={identityKey} api={api} identityKey={identityKey} platformHost={platformHost} runtimeSlot={runtimeSlot}>{children}</ConnectedOnboarding>;
}
