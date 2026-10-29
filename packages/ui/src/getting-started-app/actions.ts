import { gettingStartedAppTask, type GettingStartedAppTaskId } from "@matrix-os/contracts";

/** What a Getting started app button does; each surface carries it out with its own navigation. */
export type GettingStartedAppAction =
  | { type: "chat"; prompt?: string }
  | { type: "app-gallery" }
  | { type: "settings"; section: "integrations" | "agents-providers" }
  | { type: "external"; url: string }
  | { type: "support" };

export const GETTING_STARTED_APP_FIRST_PROMPT = "Build me a habit tracker";
export const GETTING_STARTED_APP_MOBILE_URL = "https://matrix-os.com/mobile";

const ACTIONS: Record<GettingStartedAppTaskId, GettingStartedAppAction | null> = {
  "first-prompt": { type: "chat", prompt: GETTING_STARTED_APP_FIRST_PROMPT },
  "build-app": { type: "app-gallery" },
  "create-agent": { type: "chat", prompt: "Create an agent that " },
  "build-memory": { type: "chat", prompt: "Here is what matters to me: " },
  slack: { type: "settings", section: "integrations" },
  whatsapp: { type: "settings", section: "integrations" },
  github: { type: "settings", section: "agents-providers" },
  "ai-provider": { type: "settings", section: "agents-providers" },
  "mobile-app": { type: "external", url: GETTING_STARTED_APP_MOBILE_URL },
  // Needs referrals (GTM-529).
  "invite-friends": null,
};

export function gettingStartedAppAction(id: GettingStartedAppTaskId): GettingStartedAppAction | null {
  return ACTIONS[id];
}

/** Button label on the hero card for a task. */
export function gettingStartedAppActionLabel(id: GettingStartedAppTaskId): string {
  const action = ACTIONS[id];
  if (!action) return "Coming soon";
  if (action.type === "chat") return id === "first-prompt" ? "Start in chat" : "Do it in chat";
  if (action.type === "app-gallery") return "Open App Gallery";
  if (action.type === "settings") return "Connect";
  if (action.type === "external") return "Get the app";
  return "Open";
}

export function gettingStartedAppToastText(id: GettingStartedAppTaskId, points: number): string {
  return `${gettingStartedAppTask(id).doneMessage} +${points} pts`;
}
