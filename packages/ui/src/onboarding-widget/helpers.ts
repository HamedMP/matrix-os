import type { OnboardingAiPanel, OnboardingAiProvider, OnboardingRequiredService } from "@matrix-os/contracts";
import type { OnboardingWidgetApp } from "./types.js";

export const AI_KEY_MAX_CHARS = 512;

export const PROVIDER_COPY: Record<OnboardingAiProvider, {
  name: string;
  menuName: string;
  menuLine: string;
  account: string;
  vendor: string;
  keyPlaceholder: string;
}> = {
  claude: {
    name: "Claude",
    menuName: "Claude",
    menuLine: "Use your Claude plan",
    account: "Claude account",
    vendor: "Anthropic",
    keyPlaceholder: "sk-ant-…",
  },
  codex: {
    name: "ChatGPT",
    menuName: "ChatGPT / Codex",
    menuLine: "Use your ChatGPT plan",
    account: "ChatGPT account",
    vendor: "OpenAI",
    keyPlaceholder: "sk-…",
  },
};

export function providerWaitingLabel(panel: OnboardingAiPanel | null): string | null {
  return panel?.step === "waiting" && panel.status === "waiting" ? `Connecting ${PROVIDER_COPY[panel.provider].name}…` : null;
}

export function connectedAppIds(apps: readonly OnboardingWidgetApp[]): string[] {
  return apps.filter((app) => app.status === "connected").map((app) => app.id);
}

/** Names of apps connected since `connectedBefore` was taken, for the Done confirmation. */
export function newlyConnectedNames(apps: readonly OnboardingWidgetApp[], connectedBefore: readonly string[]): string[] {
  const before = new Set(connectedBefore);
  return apps.filter((app) => app.status === "connected" && !before.has(app.id)).map((app) => app.name);
}

export function connectedServices(apps: readonly OnboardingWidgetApp[]): OnboardingRequiredService[] {
  return apps
    .filter((app) => app.status === "connected" && (app.id === "google_calendar" || app.id === "github"))
    .map((app) => app.id as OnboardingRequiredService);
}
