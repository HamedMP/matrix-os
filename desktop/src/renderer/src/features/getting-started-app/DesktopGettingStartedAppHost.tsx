/**
 * Electron Desktop host for the Getting started app (spec 639): one shared
 * state for the shell, toasts through sonner, and the tab body for the
 * `getting-started` tab kind.
 */
import {
  GettingStartedAppProvider,
  GettingStartedAppView,
  useGetStartedEnded,
  useGettingStartedApp,
  GettingStartedAppToastView,
  type GettingStartedAppAction,
  type GettingStartedAppToast,
} from "@matrix-os/ui";
import { useCallback, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useDesktopIcons } from "../../stores/desktop-icons";
import { useUi } from "../../stores/ui";
import { seedNewChatDraft } from "../chat/use-chat-composer-drafts";
import { showOnboardingTab as showTab } from "../onboarding-widget/onboarding-widget-navigation";
import { openDesktopSupport } from "../support/DesktopSupportWidget";
import { GETTING_STARTED_PATH, GETTING_STARTED_TAB, createDesktopGettingStartedAppPort } from "./desktop-getting-started-app-port";

function openGettingStartedTab(): void {
  showTab(GETTING_STARTED_TAB);
}

function runAction(action: GettingStartedAppAction): void {
  switch (action.type) {
    case "chat":
      if (action.prompt) seedNewChatDraft(action.prompt);
      showTab({ kind: "work", title: "Chat", workRoute: "chat", chatView: "draft" });
      return;
    case "app-gallery":
      showTab({ kind: "app", slug: "app-gallery", title: "App Gallery" });
      return;
    case "settings":
      useUi.getState().requestSettingsSection(action.section === "integrations" ? "services" : "providers");
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

/** Tab body for the `getting-started` tab kind. */
export function DesktopGettingStartedAppWindow() {
  const state = useGettingStartedApp();
  if (state && !state.enabled) {
    return <div className="flex h-full items-center justify-center p-6 text-sm text-[var(--text-secondary)]">Getting started is not available on this computer yet.</div>;
  }
  return <GettingStartedAppView onAction={runAction} />;
}

export function DesktopGettingStartedAppHost({ children }: { children: ReactNode }) {
  const api = useConnection((state) => state.api);
  const port = useMemo(() => (api ? createDesktopGettingStartedAppPort(api) : null), [api]);
  const getStartedEnded = useGetStartedEnded();
  const showToast = useCallback((completion: GettingStartedAppToast) => {
    toast.custom(() => <GettingStartedAppToastView toast={completion} />);
  }, []);
  // Spec 639: the icon goes on every owner's desktop once (the server decides which surface places it).
  const desktopIconsLoaded = useDesktopIcons((state) => state.loaded);
  const placeDesktopIcon = useCallback(() => {
    if (!api) return;
    void useDesktopIcons.getState().add(GETTING_STARTED_PATH, api).then((result) => {
      if (result === "failed" || result === "desktop-full") console.warn("[getting-started-app] desktop icon not placed:", result);
    }).catch((error: unknown) => {
      console.warn("[getting-started-app] unable to add desktop icon:", error instanceof Error ? error.name : typeof error);
    });
  }, [api]);
  return (
    <GettingStartedAppProvider
      port={port}
      onToast={showToast}
      autoOpenEligible={getStartedEnded}
      onAutoOpen={openGettingStartedTab}
      desktopIconReady={desktopIconsLoaded}
      onPlaceDesktopIcon={placeDesktopIcon}
      onOpen={openGettingStartedTab}
    >
      {children}
    </GettingStartedAppProvider>
  );
}
