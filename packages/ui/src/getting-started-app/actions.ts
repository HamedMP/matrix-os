import { gettingStartedAppTask, type GettingStartedAppTaskId } from "@matrix-os/contracts";

/** What a Getting started app button does; each surface carries it out with its own navigation. */
export type GettingStartedAppAction =
  | { type: "chat"; prompt?: string }
  | { type: "app-gallery" }
  | { type: "settings"; section: "integrations" | "agents-providers" }
  /** Starts the app's own sign-in where Getting started is, by Settings › Integrations catalog id. */
  | { type: "connect"; service: string }
  | { type: "external"; url: string }
  | { type: "support" };

export const GETTING_STARTED_APP_FIRST_PROMPT = "Build me a habit tracker";
export const GETTING_STARTED_APP_MOBILE_URL = "https://matrix-os.com/mobile";

const ACTIONS: Record<GettingStartedAppTaskId, GettingStartedAppAction | null> = {
  "first-prompt": { type: "chat", prompt: GETTING_STARTED_APP_FIRST_PROMPT },
  "build-app": { type: "app-gallery" },
  "create-agent": { type: "chat", prompt: "Create an agent that " },
  "build-memory": { type: "chat", prompt: "Here is what matters to me: " },
  gmail: { type: "connect", service: "gmail" },
  "google-calendar": { type: "connect", service: "google_calendar" },
  slack: { type: "connect", service: "slack" },
  // A messaging channel set up in Settings, not an app sign-in.
  whatsapp: { type: "settings", section: "integrations" },
  github: { type: "connect", service: "github" },
  "ai-provider": { type: "settings", section: "agents-providers" },
  "mobile-app": { type: "external", url: GETTING_STARTED_APP_MOBILE_URL },
  // Needs referrals (GTM-529).
  "invite-friends": null,
};

export function gettingStartedAppAction(id: GettingStartedAppTaskId): GettingStartedAppAction | null {
  return ACTIONS[id];
}

/** Where a card's own sign-in stands: in progress, not finished, or neither. */
export function gettingStartedAppSignIn(
  id: GettingStartedAppTaskId,
  connectingService: string | null,
  failedServices: readonly string[],
): "connecting" | "failed" | null {
  const action = ACTIONS[id];
  if (action?.type !== "connect") return null;
  if (action.service === connectingService) return "connecting";
  return failedServices.includes(action.service) ? "failed" : null;
}

/** Button label on the hero card for a task. */
export function gettingStartedAppActionLabel(id: GettingStartedAppTaskId): string {
  const action = ACTIONS[id];
  if (!action) return "Coming soon";
  if (action.type === "chat") return id === "first-prompt" ? "Start in chat" : "Do it in chat";
  if (action.type === "app-gallery") return "Open App Gallery";
  if (action.type === "settings" || action.type === "connect") return "Connect";
  if (action.type === "external") return "Get the app";
  return "Open";
}

/** A completion toast: "Slack connected" with "+20 pts" (Figma 1938:1226). */
export interface GettingStartedAppToast {
  title: string;
  points: number;
}

export function gettingStartedAppToast(id: GettingStartedAppTaskId, points: number): GettingStartedAppToast {
  return { title: gettingStartedAppTask(id).doneMessage, points };
}

/** Plain-text form, for screen readers and text-only surfaces. */
export function gettingStartedAppToastText(toast: GettingStartedAppToast): string {
  return `${toast.title} +${toast.points} pts`;
}
