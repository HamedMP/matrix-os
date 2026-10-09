import type {
  OnboardingAiProvider,
  OnboardingRunView,
  OnboardingWidgetEvent,
  OnboardingWidgetState,
} from "@matrix-os/contracts";

export type OnboardingAppCategory = "work" | "personal" | "dev";

export interface OnboardingWidgetApp {
  id: string;
  name: string;
  logoUrl?: string;
  category: OnboardingAppCategory;
  status: "connected" | "connecting" | "available";
}

export interface OnboardingWidgetRepo {
  name: string;
  url: string;
  updatedLabel?: string;
}

export interface OnboardingWidgetPrefs {
  keepInCorner: boolean;
  side: "right" | "left";
  showOnLogin: boolean;
}

export interface OnboardingWidgetActions {
  dispatch(event: OnboardingWidgetEvent): void;
  connectApp(serviceId: string): void;
  openResult(): void;
  openFullChat(): void;
  openSettings(): void;
  addCredits(): void;
  startAiSignIn(provider: OnboardingAiProvider): void;
  reopenAiSignIn(): void;
  cancelAiSignIn(): void;
  submitAiKey(provider: OnboardingAiProvider, key: string): void;
  changePrefs(prefs: OnboardingWidgetPrefs): void;
}

export interface OnboardingWidgetProps {
  state: OnboardingWidgetState;
  actions: OnboardingWidgetActions;
  userName?: string;
  apps: readonly OnboardingWidgetApp[];
  repos: readonly OnboardingWidgetRepo[] | null;
  runView: OnboardingRunView | null;
  connectedProviders: readonly OnboardingAiProvider[];
  creditsExhausted: boolean;
  prefs: OnboardingWidgetPrefs;
  zIndex?: number;
}
