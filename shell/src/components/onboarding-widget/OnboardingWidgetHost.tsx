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
} from "@matrix-os/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useChatProviderState } from "@/components/chat-app-provider-setup";
import { useWindowManager } from "@/hooks/useWindowManager";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "@/lib/canonical-provider-setup";
import { createCanonicalShellChatClient } from "@/lib/canonical-chat-client";
import { getGatewayUrl } from "@/lib/gateway";
import { closeShellSupport, isShellSupportOpen, subscribeShellSupportPanel } from "@/lib/posthog-client";
import { createWebProviderWorkflowClient, openWebProviderWorkflowAuthorization } from "@/lib/provider-workflow-transport";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import {
  createShellOnboardingChatPort,
  createShellOnboardingRepoSource,
  shellOnboardingIdentity,
  type ShellOnboardingIdentity,
} from "./shell-onboarding-ports";
import { useShellOnboardingIntegrations } from "./use-shell-onboarding-integrations";

const IDENTITY_TIMEOUT_MS = 10_000;
const EMPTY_CATALOG: CanonicalProviderCatalog = { revision: "onboarding-loading", drivers: [], instances: [] };

export interface OnboardingWidgetHostProps {
  onOpenChat: (chatId: string | null) => void;
  onOpenSettings: (section: OnboardingSettingsSection) => void;
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    const response = await fetch(`${getGatewayUrl()}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS),
    });
    return response.ok ? await response.json() : null;
  } catch (error: unknown) {
    console.warn("[onboarding-widget] identity unavailable:", error instanceof Error ? error.name : typeof error);
    return null;
  }
}

function useShellOnboardingIdentity(): ShellOnboardingIdentity | null {
  const { data } = useQuery({
    queryKey: ["onboarding-widget", "identity"],
    queryFn: async () => {
      const [owner, system] = await Promise.all([readOptionalJson("/api/identity"), readOptionalJson("/api/system/info")]);
      return shellOnboardingIdentity(owner, system);
    },
    staleTime: Number.POSITIVE_INFINITY,
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

export function OnboardingWidgetHost(props: OnboardingWidgetHostProps) {
  // Held before identity loads so the checklist can't auto-open over the widget in the meantime.
  useGettingStartedAutoOpenSuppression();
  const identity = useShellOnboardingIdentity();
  if (!identity) return null;
  const prefsKey = onboardingPrefsKey(identity.handle, identity.runtimeSlot);
  return <OnboardingWidgetLoader key={prefsKey} prefsKey={prefsKey} displayName={identity.displayName} {...props} />;
}

function OnboardingWidgetLoader(props: OnboardingWidgetHostProps & { prefsKey: string; displayName: string | null }) {
  const [prefs] = useState<OnboardingStoredPrefs>(() => readOnboardingPrefs(props.prefsKey) ?? DEFAULT_ONBOARDING_PREFS);
  return <OnboardingWidgetSession {...props} initialPrefs={prefs} />;
}

function OnboardingWidgetSession({ prefsKey, displayName, initialPrefs, onOpenChat, onOpenSettings }: OnboardingWidgetHostProps & {
  prefsKey: string;
  displayName: string | null;
  initialPrefs: OnboardingStoredPrefs;
}) {
  const { state, dispatch, prefs, setPrefs } = useOnboardingWidgetState(initialPrefs);
  const provider = useChatProviderState();
  const chatPort = useMemo(() => createShellOnboardingChatPort(createCanonicalShellChatClient({ gatewayUrl: getGatewayUrl() })), []);
  const repoSource = useMemo(() => createShellOnboardingRepoSource(getGatewayUrl()), []);
  const aiPort = useMemo<OnboardingAiConnectPort>(() => ({
    client: createWebProviderWorkflowClient(),
    openAuthorization: openWebProviderWorkflowAuthorization,
    isIdentityCurrent: () => true,
    onConnected: () => window.dispatchEvent(new Event(PROVIDER_SETTINGS_CHANGED_EVENT)),
  }), []);
  const integrations = useShellOnboardingIntegrations(dispatch);

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
  useOnboardingSupportDock({ size: state.size, side: prefs.side, visible: !chatFullscreen, supportOpen, dispatch, closeSupport: closeShellSupport });
  if (chatFullscreen) return null;
  return <OnboardingWidget {...widget} zIndex={SHELL_Z_INDEX.onboardingWidget} />;
}
