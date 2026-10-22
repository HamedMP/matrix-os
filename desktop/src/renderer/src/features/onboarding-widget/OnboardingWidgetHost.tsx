import {
  DEFAULT_ONBOARDING_PREFS,
  OnboardingWidget,
  onboardingPrefsKey,
  readOnboardingPrefs,
  useGettingStartedAutoOpenSuppression,
  useOnboardingWidgetSession,
  useOnboardingWidgetState,
  type OnboardingSettingsSection,
  type OnboardingStoredPrefs,
  type OnboardingWidgetBox,
} from "@matrix-os/ui";
import { useCallback, useMemo, useState } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { ApiClient } from "../../lib/api";
import { createCanonicalChatClient } from "../../lib/canonical-chat-client";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { createLegacyGlobalProviderCatalog } from "../chat/canonical-composer-adapter";
import { useChatProviderCatalog } from "../chat/chat-provider-catalog";
import { useIntegrations } from "../integrations/integrations-store";
import { closeDesktopSupport } from "../support/DesktopSupportWidget";
import { showOnboardingTab as showTab } from "./onboarding-widget-navigation";
import { createDesktopOnboardingChatPort, createDesktopOnboardingRepoSource } from "./onboarding-widget-runner";
import { useDesktopOnboardingAiPort } from "./use-onboarding-ai-connect";
import { useOnboardingAppConnect } from "./use-onboarding-app-connect";
import { useOnboardingOverlayLease } from "./use-onboarding-overlay-lease";
import { useChatMaximized } from "./use-chat-maximized";
import { useOnboardingSupportDock } from "./use-onboarding-support-dock";

const FALLBACK_CATALOG = createLegacyGlobalProviderCatalog({ hasProject: false });

export default function OnboardingWidgetHost() {
  const status = useConnection((state) => state.status);
  const api = useConnection((state) => state.api);
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const signedIn = status === "signed-in" && !!api && !!handle;
  useGettingStartedAutoOpenSuppression(signedIn);
  if (!signedIn) return null;
  const prefsKey = onboardingPrefsKey(handle, runtimeSlot);
  return <OnboardingWidgetLoader key={prefsKey} api={api} prefsKey={prefsKey} />;
}

function OnboardingWidgetLoader({ api, prefsKey }: { api: ApiClient; prefsKey: string }) {
  const [prefs] = useState<OnboardingStoredPrefs>(() => readOnboardingPrefs(prefsKey) ?? DEFAULT_ONBOARDING_PREFS);
  return <OnboardingWidgetSession api={api} prefsKey={prefsKey} initialPrefs={prefs} />;
}

function OnboardingWidgetSession({ api, prefsKey, initialPrefs }: { api: ApiClient; prefsKey: string; initialPrefs: OnboardingStoredPrefs }) {
  const { state, dispatch, prefs, setPrefs } = useOnboardingWidgetState(initialPrefs);
  const displayName = useConnection((s) => s.displayName);
  const requestSettingsSection = useUi((s) => s.requestSettingsSection);
  const available = useIntegrations((s) => s.available);
  const connections = useIntegrations((s) => s.connections);
  const { catalog, initialLoading } = useChatProviderCatalog(FALLBACK_CATALOG);
  const chatPort = useMemo(() => createDesktopOnboardingChatPort(api, createCanonicalChatClient(api)), [api]);
  const repoSource = useMemo(() => createDesktopOnboardingRepoSource(api), [api]);
  const aiPort = useDesktopOnboardingAiPort(api);
  const appConnect = useOnboardingAppConnect(api, dispatch);

  const openChat = useCallback((chatId: string | null) => {
    showTab(chatId
      ? { kind: "work", title: "Chat", workRoute: "chat", chatId, chatView: "conversation", closable: false }
      : { kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false });
  }, []);
  const openSettings = useCallback((section: OnboardingSettingsSection) => {
    requestSettingsSection(section);
    showTab({ kind: "settings", title: "Settings" });
  }, [requestSettingsSection]);

  const widget = useOnboardingWidgetSession({
    prefsKey, state, dispatch, prefs, setPrefs, displayName,
    catalog, catalogLoading: initialLoading, chatPort, aiPort, repoSource,
    available, connections, appConnect, openChat, openSettings,
  });

  const chatMaximized = useChatMaximized();
  const [widgetSize, setWidgetSize] = useState<OnboardingWidgetBox | null>(null);
  useOnboardingSupportDock({ size: state.size, position: prefs.position, widgetSize, visible: !chatMaximized, dispatch, closeSupport: closeDesktopSupport });
  useOnboardingOverlayLease(state.size !== "bubble" && !chatMaximized);
  if (chatMaximized) return null;
  return <OnboardingWidget {...widget} zIndex={DESKTOP_Z_INDEX.nativeDesktopTaskbar} onSizeChange={setWidgetSize} />;
}
