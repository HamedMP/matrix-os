import {
  initialOnboardingWidgetState,
  reduceOnboardingWidget,
  type OnboardingWidgetState,
} from "@matrix-os/contracts";
import {
  OnboardingWidget,
  type OnboardingWidgetActions,
  type OnboardingWidgetPrefs,
  type OnboardingWidgetRepo,
} from "@matrix-os/ui";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { ApiClient } from "../../lib/api";
import { createCanonicalChatClient } from "../../lib/canonical-chat-client";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";
import { createLegacyGlobalProviderCatalog } from "../chat/canonical-composer-adapter";
import { useChatProviderCatalog } from "../chat/chat-provider-catalog";
import { useIntegrations } from "../integrations/integrations-store";
import {
  DEFAULT_ONBOARDING_PREFS,
  onboardingLoginPresentation,
  onboardingPrefsKey,
  readOnboardingPrefs,
  writeOnboardingPrefs,
  type OnboardingStoredPrefs,
} from "./onboarding-widget-prefs";
import {
  loadOnboardingRepos,
  onboardingApps,
  onboardingConnectedProviders,
  onboardingCreditsExhausted,
  onboardingSelection,
} from "./onboarding-widget-runner";
import { useOnboardingAiConnect } from "./use-onboarding-ai-connect";
import { useOnboardingAppConnect } from "./use-onboarding-app-connect";
import { useOnboardingRun } from "./use-onboarding-run";

const EXISTING_USER_CHECK_MS = 4_000;
const FALLBACK_CATALOG = createLegacyGlobalProviderCatalog({ hasProject: false });

export default function OnboardingWidgetHost() {
  const status = useConnection((state) => state.status);
  const api = useConnection((state) => state.api);
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  if (status !== "signed-in" || !api || !handle) return null;
  const prefsKey = onboardingPrefsKey(handle, runtimeSlot);
  return <OnboardingWidgetLoader key={prefsKey} api={api} prefsKey={prefsKey} />;
}

/** Decides the starting prefs: stored ones, or for a first visit, whether this owner already uses Chat. */
function OnboardingWidgetLoader({ api, prefsKey }: { api: ApiClient; prefsKey: string }) {
  const [prefs, setPrefs] = useState<OnboardingStoredPrefs | null>(() => readOnboardingPrefs(prefsKey));

  useEffect(() => {
    if (prefs) return;
    let settled = false;
    const settle = (existingUser: boolean) => {
      if (settled) return;
      settled = true;
      const next = { ...DEFAULT_ONBOARDING_PREFS, firstTaskCompleted: existingUser, keepInCorner: !existingUser };
      writeOnboardingPrefs(prefsKey, next);
      setPrefs(next);
    };
    const timer = setTimeout(() => settle(false), EXISTING_USER_CHECK_MS);
    createCanonicalChatClient(api).list().then(
      (result) => settle(result.items.length > 0),
      (error: unknown) => {
        console.warn("[onboarding-widget] chat history check failed:", error instanceof Error ? error.name : typeof error);
        settle(false);
      },
    );
    return () => {
      settled = true;
      clearTimeout(timer);
    };
  }, [api, prefs, prefsKey]);

  if (!prefs) return null;
  return <OnboardingWidgetSession api={api} prefsKey={prefsKey} initialPrefs={prefs} />;
}

function initialState(prefs: OnboardingStoredPrefs): OnboardingWidgetState {
  return initialOnboardingWidgetState({
    size: onboardingLoginPresentation(prefs) === "corner" ? "corner" : "bubble",
    firstTaskCompleted: prefs.firstTaskCompleted,
    aiChoice: prefs.aiChoice,
    chatId: prefs.chatId,
  });
}

function OnboardingWidgetSession({ api, prefsKey, initialPrefs }: { api: ApiClient; prefsKey: string; initialPrefs: OnboardingStoredPrefs }) {
  const [state, dispatch] = useReducer(reduceOnboardingWidget, initialPrefs, initialState);
  const [prefs, setPrefs] = useState<OnboardingWidgetPrefs>(() => ({
    keepInCorner: initialPrefs.keepInCorner, side: initialPrefs.side, showOnLogin: initialPrefs.showOnLogin,
  }));
  const displayName = useConnection((s) => s.displayName);
  const requestSettingsSection = useUi((s) => s.requestSettingsSection);
  const available = useIntegrations((s) => s.available);
  const connections = useIntegrations((s) => s.connections);

  const client = useMemo(() => createCanonicalChatClient(api), [api]);
  const { catalog, initialLoading } = useChatProviderCatalog(FALLBACK_CATALOG);
  const selection = useMemo(() => onboardingSelection(catalog, state.aiChoice), [catalog, state.aiChoice]);
  const connectedProviders = useMemo(() => onboardingConnectedProviders(catalog), [catalog]);
  const creditsExhausted = useMemo(() => onboardingCreditsExhausted(catalog, selection), [catalog, selection]);

  const runView = useOnboardingRun(state, dispatch, { api, client, selection, selectionPending: initialLoading });
  const ai = useOnboardingAiConnect(api, dispatch);
  const appConnect = useOnboardingAppConnect(api, dispatch);
  const apps = useMemo(() => onboardingApps(available, connections, appConnect.connectingService), [appConnect.connectingService, available, connections]);

  const githubConnected = connections.some((connection) => connection.service === "github");
  const onRepoScreen = state.screen.kind === "repo";
  const [repos, setRepos] = useState<OnboardingWidgetRepo[] | null>(null);
  useEffect(() => {
    if (!onRepoScreen) return;
    if (!githubConnected) { setRepos([]); return; }
    const controller = new AbortController();
    setRepos(null);
    loadOnboardingRepos(api, controller.signal).then(setRepos, (error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[onboarding-widget] repo list failed:", error instanceof Error ? error.name : typeof error);
      setRepos([]);
    });
    return () => controller.abort();
  }, [api, githubConnected, onRepoScreen]);

  useEffect(() => {
    writeOnboardingPrefs(prefsKey, {
      ...prefs,
      firstTaskCompleted: state.firstTaskCompleted,
      aiChoice: state.aiChoice,
      chatId: state.chatId,
    });
  }, [prefs, prefsKey, state.aiChoice, state.chatId, state.firstTaskCompleted]);

  const openChat = useCallback(() => {
    useTabs.getState().openTab(state.chatId
      ? { kind: "work", title: "Chat", workRoute: "chat", chatId: state.chatId, chatView: "conversation", closable: false }
      : { kind: "work", title: "Chat", workRoute: "chat", chatView: "draft", closable: false });
    dispatch({ type: "size.changed", size: "bubble" });
  }, [state.chatId]);

  const openSettings = useCallback((section: string) => {
    requestSettingsSection(section);
    useTabs.getState().openTab({ kind: "settings", title: "Settings" });
  }, [requestSettingsSection]);

  const actions = useMemo<OnboardingWidgetActions>(() => ({
    dispatch,
    connectApp: appConnect.connectApp,
    openResult: openChat,
    openFullChat: openChat,
    openSettings: () => openSettings("providers"),
    addCredits: () => openSettings("billing"),
    startAiSignIn: ai.startSignIn,
    reopenAiSignIn: ai.reopenSignIn,
    cancelAiSignIn: ai.cancelSignIn,
    submitAiKey: ai.submitKey,
    changePrefs: setPrefs,
  }), [ai.cancelSignIn, ai.reopenSignIn, ai.startSignIn, ai.submitKey, appConnect.connectApp, openChat, openSettings]);

  return (
    <OnboardingWidget
      state={state}
      actions={actions}
      userName={firstName(displayName)}
      apps={apps}
      repos={repos}
      runView={runView}
      connectedProviders={connectedProviders}
      creditsExhausted={creditsExhausted}
      aiSignInCode={ai.signInCode}
      prefs={prefs}
      zIndex={DESKTOP_Z_INDEX.nativeDesktopTaskbar}
    />
  );
}

function firstName(displayName: string | null): string | undefined {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : undefined;
}
