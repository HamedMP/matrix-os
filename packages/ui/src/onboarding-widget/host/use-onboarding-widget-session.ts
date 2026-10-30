import {
  initialOnboardingWidgetState,
  onboardingPendingRun,
  reduceOnboardingWidget,
  type AvailableIntegration,
  type CanonicalProviderCatalog,
  type ConnectedIntegration,
  type OnboardingWidgetEvent,
  type OnboardingWidgetState,
  getStartedBuildSuggestion,
  getStartedTaskOrder,
  getStartedWidgetIntro,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { OnboardingWidgetActions, OnboardingWidgetPrefs, OnboardingWidgetProps, OnboardingWidgetRepo } from "../types.js";
import { onboardingActiveAi, onboardingAiDetail, onboardingAiForInstance, onboardingApps, onboardingConnectedProviders, onboardingConnectionLabels, onboardingCreditsExhausted, onboardingSelection } from "./catalog.js";
import type { OnboardingChatPort } from "./chat-port.js";
import { onboardingSessionInit, writeOnboardingPrefs, type OnboardingStoredPrefs } from "./prefs.js";
import { loadOnboardingRepos, type OnboardingRepoSource } from "./repos.js";
import { useOnboardingAiConnect, type OnboardingAiConnectPort } from "./use-onboarding-ai-connect.js";
import { useOnboardingAutoBuild } from "./use-onboarding-auto-build.js";
import { useOnboardingChatHandoff } from "./use-onboarding-chat-handoff.js";
import { useOnboardingRun } from "./use-onboarding-run.js";
import { onboardingWidgetStatus, useOnboardingTaskRequests, usePublishOnboardingWidgetStatus } from "../task-requests.js";
import { connectedServices } from "../helpers.js";
import { useConsumeGetStartedFinishedNow, useGetStartedAnswers, useGetStartedFinishedNow } from "../../get-started/answers-context.js";

export interface OnboardingAppConnect {
  connectingService: string | null;
  connectApp: (serviceId: string) => void;
  /** The computer has no app connection service; hosts dispatch `connect.unavailable` instead of trying. */
  appsUnavailable: boolean;
}

export type OnboardingSettingsSection = "agents-providers" | "billing";

function initialState(prefs: OnboardingStoredPrefs): OnboardingWidgetState {
  return initialOnboardingWidgetState(onboardingSessionInit(prefs));
}

export function useOnboardingWidgetState(initialPrefs: OnboardingStoredPrefs) {
  const [state, dispatch] = useReducer(reduceOnboardingWidget, initialPrefs, initialState);
  const [prefs, setPrefs] = useState<OnboardingWidgetPrefs>(() => ({
    keepInCorner: initialPrefs.keepInCorner, position: initialPrefs.position, showOnLogin: initialPrefs.showOnLogin,
  }));
  return { state, dispatch, prefs, setPrefs };
}

export interface OnboardingWidgetSessionInput {
  prefsKey: string;
  state: OnboardingWidgetState;
  dispatch: (event: OnboardingWidgetEvent) => void;
  prefs: OnboardingWidgetPrefs;
  setPrefs: (prefs: OnboardingWidgetPrefs) => void;
  displayName: string | null;
  catalog: CanonicalProviderCatalog;
  catalogLoading: boolean;
  chatPort: OnboardingChatPort | null;
  aiPort: OnboardingAiConnectPort | null;
  /** Must be referentially stable; repo loads restart when it changes. */
  repoSource: OnboardingRepoSource;
  available: readonly AvailableIntegration[];
  connections: readonly ConnectedIntegration[];
  appConnect: OnboardingAppConnect;
  openChat: (chatId: string | null) => void;
  openSettings: (section: OnboardingSettingsSection) => void;
}

/** Everything a host renders `OnboardingWidget` with, minus its own layering. */
export function useOnboardingWidgetSession(input: OnboardingWidgetSessionInput): Omit<OnboardingWidgetProps, "zIndex"> {
  const { prefsKey, state, dispatch, prefs, setPrefs, catalog, repoSource, available, connections, appConnect, openChat, openSettings } = input;
  const loading = input.catalogLoading;
  const activeAi = useMemo(() => (loading ? state.aiChoice : onboardingActiveAi(catalog, state.aiChoice)), [catalog, loading, state.aiChoice]);
  const matrixAvailable = useMemo(() => loading || onboardingSelection(catalog, "matrix") !== null, [catalog, loading]);
  const selection = useMemo(() => onboardingSelection(catalog, activeAi), [catalog, activeAi]);
  const connectedProviders = useMemo(() => onboardingConnectedProviders(catalog), [catalog]);
  const connectionLabels = useMemo(() => onboardingConnectionLabels(catalog), [catalog]);
  const aiDetail = useMemo(() => (loading ? null : onboardingAiDetail(catalog, activeAi)), [catalog, loading, activeAi]);
  const creditsExhausted = useMemo(() => onboardingCreditsExhausted(catalog, selection), [catalog, selection]);

  const [runInstanceId, setRunInstanceId] = useState<string | null>(null);
  const runView = useOnboardingRun(state, dispatch, { port: input.chatPort, selection, selectionPending: loading, onRunInstance: setRunInstanceId });
  const followUpAi = useMemo(() => (runInstanceId ? onboardingAiForInstance(catalog, runInstanceId) : null), [catalog, runInstanceId]);
  const ai = useOnboardingAiConnect(input.aiPort, dispatch);
  const connectPanelOpen = state.ai?.step === "waiting" || state.ai?.step === "key";
  const abandonSignIn = ai.abandonSignIn;
  useEffect(() => {
    if (!connectPanelOpen) abandonSignIn();
  }, [abandonSignIn, connectPanelOpen]);
  const apps = useMemo(() => onboardingApps(available, connections, appConnect.connectingService), [appConnect.connectingService, available, connections]);
  // Spec 639: the Getting started app starts starter tasks here, in the corner widget, and mirrors this widget.
  useOnboardingTaskRequests(useCallback((taskId) => {
    dispatch({ type: "size.changed", size: "corner" });
    dispatch({ type: "task.selected", taskId, connectedServices: connectedServices(apps) });
  }, [apps, dispatch]), useCallback(() => dispatch({ type: "size.changed", size: "corner" }), [dispatch]));
  usePublishOnboardingWidgetStatus(onboardingWidgetStatus(state));

  const github = connections.find((connection) => connection.service === "github" && connection.status === "active")
    ?? connections.find((connection) => connection.service === "github");
  const githubId = github?.id ?? null;
  const githubLabel = github?.accountLabel ?? null;
  const onRepoScreen = state.screen.kind === "repo";
  const [repos, setRepos] = useState<OnboardingWidgetRepo[] | null>(null);
  useEffect(() => {
    if (!onRepoScreen) return;
    const controller = new AbortController();
    setRepos(null);
    const githubApp = githubId && githubLabel ? { id: githubId, accountLabel: githubLabel } : null;
    loadOnboardingRepos(repoSource, githubApp, controller.signal).then(setRepos, (error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn("[onboarding-widget] repo list failed:", error instanceof Error ? error.name : typeof error);
      setRepos([]);
    });
    return () => controller.abort();
  }, [githubId, githubLabel, onRepoScreen, repoSource]);

  useEffect(() => {
    writeOnboardingPrefs(prefsKey, {
      ...prefs,
      firstTaskCompleted: state.firstTaskCompleted,
      aiChoice: state.aiChoice,
      chatId: state.chatId,
      pendingRun: onboardingPendingRun(state),
    });
  }, [prefs, prefsKey, state]);

  const showChat = useCallback(() => {
    openChat(state.chatId);
    dispatch({ type: "size.changed", size: "bubble" });
  }, [dispatch, openChat, state.chatId]);
  const openNamedChat = useOnboardingChatHandoff(state, showChat);

  const actions = useMemo<OnboardingWidgetActions>(() => ({
    dispatch,
    connectApp: appConnect.connectApp,
    openResult: openNamedChat,
    openFullChat: showChat,
    openSettings: () => openSettings("agents-providers"),
    addCredits: () => openSettings("billing"),
    startAiSignIn: ai.startSignIn,
    reopenAiSignIn: ai.reopenSignIn,
    cancelAiSignIn: ai.cancelSignIn,
    submitAiKey: ai.submitKey,
    submitAiCode: ai.submitCode,
    changePrefs: setPrefs,
  }), [ai.cancelSignIn, ai.reopenSignIn, ai.startSignIn, ai.submitCode, ai.submitKey, appConnect.connectApp, dispatch, openNamedChat, openSettings, setPrefs, showChat]);

  // Spec 635: the name and goals from Get started win over the account's display name.
  const getStartedAnswers = useGetStartedAnswers();
  const userName = onboardingFirstName(getStartedAnswers?.name ?? input.displayName);
  const taskOrder = useMemo(() => (getStartedAnswers
    ? getStartedTaskOrder(getStartedAnswers.goals, { tools: getStartedAnswers.tools, ...(getStartedAnswers.starter ? { starter: getStartedAnswers.starter } : {}) })
    : undefined), [getStartedAnswers]);
  const intro = getStartedAnswers ? getStartedWidgetIntro(getStartedAnswers.goals) : null;
  const buildSuggestion = useMemo(() => (getStartedAnswers ? getStartedBuildSuggestion(getStartedAnswers) : null), [getStartedAnswers]);
  useOnboardingAutoBuild({
    suggestion: buildSuggestion,
    finishedNow: useGetStartedFinishedNow(),
    consumeFinishedNow: useConsumeGetStartedFinishedNow(),
    aiReady: !loading && selection !== null && !creditsExhausted,
    state,
    dispatch,
    openChat: showChat,
  });
  return {
    state,
    actions,
    ...(userName ? { userName } : {}),
    ...(taskOrder ? { taskOrder } : {}),
    ...(intro ? { intro } : {}),
    ...(buildSuggestion ? { buildSuggestion } : {}),
    apps,
    appsUnavailable: appConnect.appsUnavailable,
    repos,
    runView,
    activeAi,
    followUpAi,
    matrixAvailable,
    connectedProviders,
    connectionLabels,
    aiDetail,
    creditsExhausted,
    aiSignInCode: ai.signInCode,
    aiSignInNeedsCode: ai.signInNeedsCode,
    prefs,
  };
}

export function onboardingFirstName(displayName: string | null | undefined): string | undefined {
  const first = displayName?.trim().split(/\s+/)[0];
  return first ? first.slice(0, 40) : undefined;
}
