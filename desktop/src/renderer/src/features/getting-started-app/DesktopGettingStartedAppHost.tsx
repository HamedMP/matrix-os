/**
 * Electron Desktop host for the Getting started app (spec 639): the gateway
 * port over the signed-in API client, one shared state for the shell, toasts
 * through sonner, and the tab body for the `getting-started` tab kind.
 */
import {
  GettingStartedAppAutoOpenResponseSchema,
  GettingStartedAppAwardResponseSchema,
  GettingStartedAppProgressSchema,
} from "@matrix-os/contracts";
import {
  GettingStartedAppProvider,
  GettingStartedAppView,
  useGetStartedEnded,
  useGettingStartedApp,
  type GettingStartedAppAction,
  type GettingStartedAppPort,
} from "@matrix-os/ui";
import { useCallback, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import type { ApiClient } from "../../lib/api";
import { invoke } from "../../lib/operator";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { seedNewChatDraft } from "../chat/use-chat-composer-drafts";
import { showOnboardingTab as showTab } from "../onboarding-widget/onboarding-widget-navigation";
import { openDesktopSupport } from "../support/DesktopSupportWidget";
import { bundledDesktopIconForPath } from "../desktop-shell/bundled-app-icons";
import { loadGettingStartedResults } from "../onboarding/getting-started";

export const GETTING_STARTED_TAB = {
  kind: "getting-started" as const,
  title: "Getting started",
  icon: bundledDesktopIconForPath("__getting-started__"),
};

function httpStatus(error: unknown): number | undefined {
  return error && typeof error === "object" && "httpStatus" in error && typeof error.httpStatus === "number"
    ? error.httpStatus
    : undefined;
}

export function createDesktopGettingStartedAppPort(api: Pick<ApiClient, "get" | "post" | "forRuntime">): GettingStartedAppPort {
  return {
    loadResults: (signal) => loadGettingStartedResults(api, signal),
    async loadProgress(signal) {
      try {
        return GettingStartedAppProgressSchema.parse(await api.get("/api/getting-started/progress", { signal }));
      } catch (error: unknown) {
        if (httpStatus(error) === 404) return null;
        throw error;
      }
    },
    async award(taskId, silent) {
      return GettingStartedAppAwardResponseSchema.parse(await api.post("/api/getting-started/awards", { taskId, silent }));
    },
    async claimAutoOpen() {
      return GettingStartedAppAutoOpenResponseSchema.parse(await api.post("/api/getting-started/auto-open", {})).open;
    },
  };
}

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
  const showToast = useCallback((text: string) => {
    toast(text);
  }, []);
  return (
    <GettingStartedAppProvider
      port={port}
      onToast={showToast}
      autoOpenEligible={getStartedEnded}
      onAutoOpen={openGettingStartedTab}
      onOpen={openGettingStartedTab}
    >
      {children}
    </GettingStartedAppProvider>
  );
}
