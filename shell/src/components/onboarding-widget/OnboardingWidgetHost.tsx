"use client";

import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import {
  DEFAULT_ONBOARDING_PREFS,
  OnboardingWidget,
  onboardingPrefsKey,
  readOnboardingPrefs,
  useGettingStartedAutoOpenSuppression,
  useOnboardingSupportDock,
  useOnboardingWidgetSession,
  useOnboardingWidgetState,
  type OnboardingAiConnectPort,
  type OnboardingSettingsSection,
  type OnboardingStoredPrefs,
  type OnboardingWidgetBox,
} from "@matrix-os/ui";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useChatProviderState } from "@/components/chat-app-provider-setup";
import { useWindowManager } from "@/hooks/useWindowManager";
import { createCanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { getGatewayUrl } from "@/lib/gateway";
import { closeShellSupport, isShellSupportOpen, subscribeShellSupportPanel } from "@/lib/posthog-client";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  createShellOnboardingAiPort,
  createShellOnboardingChatPort,
  createShellOnboardingRepoSource,
  shellOnboardingIdentity,
  shellOnboardingTransportKey,
  type ShellOnboardingIdentity,
} from "./shell-onboarding-ports";
import { useShellOnboardingIntegrations } from "./use-shell-onboarding-integrations";

const IDENTITY_TIMEOUT_MS = 10_000;
const IDENTITY_RETRIES = 5;
const SIGNED_OUT_ACCOUNT = "local";
const EMPTY_CATALOG: CanonicalProviderCatalog = { revision: "onboarding-loading", drivers: [], instances: [] };

export interface OnboardingWidgetHostProps {
  /** The signed-in account; one browser profile can hold several, and their prefs must not mix. */
  accountId?: string | null;
  onOpenChat: (chatId: string | null) => void;
  onOpenSettings: (section: OnboardingSettingsSection) => void;
}

type SessionProps = Omit<OnboardingWidgetHostProps, "accountId"> & {
  prefsKey: string;
  displayName: string | null;
  gatewayUrl: string;
  transportKey: string;
};

class IdentityRequestError extends Error {
  override readonly name = "IdentityRequestError";
  constructor(readonly status: number) {
    super(`IdentityRequestFailed:${status}`);
  }
}

/** A missing route means this computer has no such field; other failures must stay retryable, not become the fallback key. */
async function readOptionalJson(gatewayUrl: string, path: string): Promise<unknown> {
  try {
    const response = await fetch(`${gatewayUrl}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new IdentityRequestError(response.status);
    return await response.json();
  } catch (error: unknown) {
    console.warn("[onboarding-widget] identity unavailable:", error instanceof IdentityRequestError ? error.message : error instanceof Error ? error.name : typeof error);
    throw error;
  }
}

/** Keyed by account and computer so a cached identity never outlives a sign-in or computer switch. */
function useShellOnboardingIdentity(account: string, gatewayUrl: string, transportKey: string): ShellOnboardingIdentity | null {
  const { data } = useQuery({
    queryKey: ["onboarding-widget", "identity", account, transportKey],
    queryFn: async () => {
      const [owner, system] = await Promise.all([readOptionalJson(gatewayUrl, "/api/identity"), readOptionalJson(gatewayUrl, "/api/system/info")]);
      return shellOnboardingIdentity(owner, system);
    },
    staleTime: Number.POSITIVE_INFINITY,
    retry: IDENTITY_RETRIES,
  });
  return data ?? null;
}

/** A maximized Chat already shows the conversation the widget would open. */
function useChatFullscreen(): boolean {
  return useWindowManager((state) => {
    const fullscreen = state.fullscreenWindowId ? state.windows.find((window) => window.id === state.fullscreenWindowId) : undefined;
    return fullscreen?.path === "__chat__" && !fullscreen.minimized;
  });
}

function useShellSupportOpen(): boolean {
  return useSyncExternalStore(subscribeShellSupportPanel, isShellSupportOpen, () => false);
}

export function OnboardingWidgetHost({ accountId, ...props }: OnboardingWidgetHostProps) {
  // Held before identity loads so the checklist can't auto-open over the widget in the meantime.
  useGettingStartedAutoOpenSuppression();
  const account = accountId || SIGNED_OUT_ACCOUNT;
  const gatewayUrl = getGatewayUrl();
  const transportKey = shellOnboardingTransportKey();
  const identity = useShellOnboardingIdentity(account, gatewayUrl, transportKey);
  if (!identity) return null;
  const prefsKey = onboardingPrefsKey(identity.handle, identity.runtimeSlot, account);
  return (
    <OnboardingWidgetLoader key={`${prefsKey}|${transportKey}`} prefsKey={prefsKey} displayName={identity.displayName}
      gatewayUrl={gatewayUrl} transportKey={transportKey} {...props} />
  );
}

function OnboardingWidgetLoader(props: SessionProps) {
  const [prefs] = useState<OnboardingStoredPrefs>(() => readOnboardingPrefs(props.prefsKey) ?? DEFAULT_ONBOARDING_PREFS);
  return <OnboardingWidgetSession {...props} initialPrefs={prefs} />;
}

function OnboardingWidgetSession({ prefsKey, displayName, gatewayUrl, transportKey, initialPrefs, onOpenChat, onOpenSettings }: SessionProps & {
  initialPrefs: OnboardingStoredPrefs;
}) {
  const { state, dispatch, prefs, setPrefs } = useOnboardingWidgetState(initialPrefs);
  const provider = useChatProviderState();
  const isCurrent = useCallback(() => shellOnboardingTransportKey() === transportKey, [transportKey]);
  const chatPort = useMemo(
    () => createShellOnboardingChatPort(createCanonicalShellChatClient({ gatewayUrl }), isCurrent),
    [gatewayUrl, isCurrent],
  );
  const repoSource = useMemo(() => createShellOnboardingRepoSource(gatewayUrl, fetch, isCurrent), [gatewayUrl, isCurrent]);
  const aiPort = useMemo<OnboardingAiConnectPort>(() => createShellOnboardingAiPort(isCurrent), [isCurrent]);
  const integrations = useShellOnboardingIntegrations(dispatch, { gatewayUrl, isCurrent });

  const widget = useOnboardingWidgetSession({
    prefsKey, state, dispatch, prefs, setPrefs, displayName,
    catalog: provider.catalog ?? EMPTY_CATALOG,
    catalogLoading: provider.catalog === null && provider.loading,
    chatPort, aiPort, repoSource,
    available: integrations.available,
    connections: integrations.connections,
    appConnect: integrations,
    openChat: onOpenChat,
    openSettings: onOpenSettings,
  });

  const chatFullscreen = useChatFullscreen();
  const supportOpen = useShellSupportOpen();
  const [widgetSize, setWidgetSize] = useState<OnboardingWidgetBox | null>(null);
  useOnboardingSupportDock({ size: state.size, position: prefs.position, widgetSize, visible: !chatFullscreen, supportOpen, dispatch, closeSupport: closeShellSupport });
  if (chatFullscreen) return null;
  return <OnboardingWidget {...widget} zIndex={SHELL_Z_INDEX.onboardingWidget} onSizeChange={setWidgetSize} />;
}
