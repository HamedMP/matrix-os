/**
 * Electron Desktop host for the Getting started app (spec 639): one shared
 * state for the shell, toasts through sonner, and the tab body for the
 * `getting-started` tab kind.
 */
import type { OnboardingWidgetEvent } from "@matrix-os/contracts";
import {
  GettingStartedAppProvider,
  GettingStartedAppView,
  useGetStartedConnectFailures,
  useGetStartedEnded,
  useGettingStartedApp,
  GettingStartedAppToastView,
  type GettingStartedAppAction,
  type GettingStartedAppToast,
} from "@matrix-os/ui";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useDesktopIcons } from "../../stores/desktop-icons";
import { useUi } from "../../stores/ui";
import { seedNewChatDraft } from "../chat/use-chat-composer-drafts";
import { showOnboardingTab as showTab } from "../onboarding-widget/onboarding-widget-navigation";
import { useOnboardingAppConnect } from "../onboarding-widget/use-onboarding-app-connect";
import { openDesktopSupport } from "../support/DesktopSupportWidget";
import { GETTING_STARTED_PATH, GETTING_STARTED_TAB, createDesktopGettingStartedAppPort } from "./desktop-getting-started-app-port";

function openGettingStartedTab(): void {
  showTab(GETTING_STARTED_TAB);
}

/** Starts an app's own sign-in from a card; null when this computer has no app connection service. */
const ConnectContext = createContext<((service: string) => void) | null>(null);

function openIntegrationsSettings(): void {
  useUi.getState().requestSettingsSection("services");
  showTab({ kind: "settings", title: "Settings" });
}

function runAction(action: GettingStartedAppAction, connect: ((service: string) => void) | null): void {
  switch (action.type) {
    case "connect":
      if (connect) connect(action.service);
      else openIntegrationsSettings();
      return;
    case "chat":
      if (action.prompt) seedNewChatDraft(action.prompt);
      showTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft" });
      return;
    case "app-gallery":
      showTab({ kind: "app", slug: "app-gallery", title: "App Gallery" });
      return;
    case "settings":
      if (action.section === "integrations") {
        openIntegrationsSettings();
        return;
      }
      useUi.getState().requestSettingsSection("providers");
      showTab({ kind: "settings", title: "Settings" });
      return;
    case "external":
      void invoke("shell:open-external", { url: action.url }).catch((error: unknown) => {
        console.warn("[getting-started-app] unable to open link:", error instanceof Error ? error.name : typeof error);
      });
      return;
    case "support":
      void openDesktopSupport();
      return;
  }
}

/** Tab body for the `getting-started` tab kind; `visible` is false while the tab is in the background. */
export function DesktopGettingStartedAppWindow({ visible = true }: { visible?: boolean }) {
  const state = useGettingStartedApp();
  const connect = useContext(ConnectContext);
  const onAction = useCallback((action: GettingStartedAppAction) => runAction(action, connect), [connect]);
  if (state && !state.enabled) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-secondary)]">Getting started is not available on this computer yet.</div>;
  }
  return <GettingStartedAppView onAction={onAction} visible={visible} />;
}

export function DesktopGettingStartedAppHost({ children }: { children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const port = useMemo(() => (api ? createDesktopGettingStartedAppPort(api) : null), [api]);
  const getStartedEnded = useGetStartedEnded();
  const showToast = useCallback((completion: GettingStartedAppToast) => {
    toast.custom(() => <GettingStartedAppToastView toast={completion} />);
  }, []);
  // Spec 639: the icon goes first on every owner's desktop once (the server decides which surface places it).
  const desktopIconsLoaded = useDesktopIcons((state) => state.loaded);
  const placeDesktopIcon = useCallback(async () => {
    if (!api) return "failed" as const;
    const result = await useDesktopIcons.getState().add(GETTING_STARTED_PATH, api, undefined, { first: true });
    if (result === "failed" || result === "desktop-full") console.warn("[getting-started-app] desktop icon not placed:", result);
    return result;
  }, [api]);
  // Cards start each app's own sign-in here (the onboarding widget's flow); a finished one re-reads progress.
  const [changeCount, setChangeCount] = useState(0);
  const { onEvent: recordFailure, clear: clearFailure, failedServices } = useGetStartedConnectFailures();
  const onConnectEvent = useCallback((event: OnboardingWidgetEvent) => {
    recordFailure(event);
    if (event.type === "connect.succeeded") setChangeCount((count) => (count + 1) % 1_000_000);
  }, [recordFailure]);
  const { connectApp: startConnect, connectingService, appsUnavailable } = useOnboardingAppConnect(api, onConnectEvent);
  const connect = useCallback((service: string) => {
    clearFailure(service);
    startConnect(service);
  }, [clearFailure, startConnect]);
  const connections = useMemo(
    () => ({ connectingService, failedServices: [...failedServices], changeCount }),
    [changeCount, connectingService, failedServices],
  );
  return (
    <GettingStartedAppProvider
      port={port}
      onToast={showToast}
      autoOpenEligible={getStartedEnded}
      onAutoOpen={openGettingStartedTab}
      desktopIconReady={desktopIconsLoaded}
      onPlaceDesktopIcon={placeDesktopIcon}
      onOpen={openGettingStartedTab}
      connections={connections}
    >
      <ConnectContext value={appsUnavailable ? null : connect}>{children}</ConnectContext>
    </GettingStartedAppProvider>
  );
}
