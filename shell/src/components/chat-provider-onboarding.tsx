"use client";
import { useCallback, useMemo, type ReactNode } from "react";
import { ChatProviderOnboarding as SharedOnboarding } from "@matrix-os/ui";
import type { ProviderConnectionAttempt } from "@matrix-os/contracts";
import { getGatewayUrl } from "@/lib/gateway";
import { createProviderSettingsTransport } from "@/lib/provider-settings-transport";
import { openProviderAuthorizationPath } from "@/lib/provider-browser-action";
import { openProviderSettings, OPEN_PROVIDER_TERMINAL_EVENT, PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";

export function ChatProviderOnboarding({ children }: { children?: ReactNode }) {
  const identityKey = getGatewayUrl();
  const transport = useMemo(() => createProviderSettingsTransport(), []);
  const onCatalogChanged = useCallback(() => {
    if (getGatewayUrl() === identityKey) window.dispatchEvent(new Event(PROVIDER_SETTINGS_CHANGED_EVENT));
  }, [identityKey]);
  const isIdentityCurrent = useCallback(() => getGatewayUrl() === identityKey, [identityKey]);
  const openAction = useCallback((action: ProviderConnectionAttempt["action"]) => {
    if (!isIdentityCurrent()) return false;
    if (action.kind === "open_terminal") {
      window.dispatchEvent(new CustomEvent(OPEN_PROVIDER_TERMINAL_EVENT, { detail: { sessionId: action.terminalSessionId } }));
      return true;
    }
    if (action.kind === "open_browser") return openProviderAuthorizationPath(action.authorizationPath);
    return false;
  }, [isIdentityCurrent]);
  const onOpenSettings = useCallback(() => {
    if (isIdentityCurrent()) openProviderSettings();
  }, [isIdentityCurrent]);
  return <SharedOnboarding key={identityKey} identityKey={identityKey} transport={transport} isIdentityCurrent={isIdentityCurrent}
    onCatalogChanged={onCatalogChanged} openAction={openAction} onOpenSettings={onOpenSettings} changedEvent={PROVIDER_SETTINGS_CHANGED_EVENT}>{children}</SharedOnboarding>;
}
