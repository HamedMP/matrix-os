import type {
  OnboardingAiChoice,
  OnboardingAiProvider,
  OnboardingRunView,
  OnboardingWidgetEvent,
  OnboardingWidgetState,
} from "@matrix-os/contracts";
import type { OnboardingWidgetBox, OnboardingWidgetPosition } from "./position.js";

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
  position: OnboardingWidgetPosition;
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
  /** Code the provider's sign-in page shows after approval, for sign-ins that finish by pasting it back. */
  submitAiCode(code: string): void;
  changePrefs(prefs: OnboardingWidgetPrefs): void;
}

export interface OnboardingWidgetProps {
  state: OnboardingWidgetState;
  actions: OnboardingWidgetActions;
  userName?: string;
  apps: readonly OnboardingWidgetApp[];
  /** This computer has no app connection service, so Connect can never finish. */
  appsUnavailable?: boolean;
  repos: readonly OnboardingWidgetRepo[] | null;
  runView: OnboardingRunView | null;
  /** The AI a new task runs on; differs from `state.aiChoice` while Matrix AI can't run on this computer. */
  activeAi: OnboardingAiChoice;
  /** The AI a follow-up runs on: the one its chat already uses, which `activeAi` can no longer change. Null when unknown. */
  followUpAi?: OnboardingAiChoice | null;
  matrixAvailable: boolean;
  connectedProviders: readonly OnboardingAiProvider[];
  /** How each connected provider is reached, as Chat's picker names it. Missing keeps the plan wording. */
  connectionLabels?: Partial<Record<OnboardingAiProvider, string>>;
  /** The model and connection the active AI runs on, e.g. "Claude Opus 5.5 · Anthropic API key". Null keeps the AI's name. */
  aiDetail?: string | null;
  creditsExhausted: boolean;
  /** Device code to type on the provider's sign-in page, when the provider uses one. */
  aiSignInCode?: string | null;
  /** The sign-in finishes by pasting the code the provider's page shows. */
  aiSignInNeedsCode?: boolean;
  prefs: OnboardingWidgetPrefs;
  zIndex?: number;
  /** Reports the widget's measured size, so the host can keep the support launcher clear of where it really shows. */
  onSizeChange?(size: OnboardingWidgetBox): void;
}
