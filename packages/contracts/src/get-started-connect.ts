import {
  GET_STARTED_TOOL_GROUPS,
  type GetStartedGoalId,
  type GetStartedToolId,
} from "#get-started";

// Spec 635, Section 4: how the wizard's tools map to integrations. Step 3
// connects through the Settings marketplace with the integrations that fit the
// owner's goals first; agent sign-ins and messaging channels are not
// integrations. Service ids are fixed here, never taken from the client.

export type GetStartedToolConnect =
  | { kind: "app"; service: string; why: string }
  | { kind: "agent"; why: string }
  | { kind: "channel"; why: string };

const TOOL_CONNECT: Record<GetStartedToolId, GetStartedToolConnect> = {
  github: { kind: "app", service: "github", why: "So your AI can work on your repos" },
  "claude-code": { kind: "agent", why: "Sign in with your Claude account from Getting started" },
  codex: { kind: "agent", why: "Sign in with your ChatGPT account from Getting started" },
  opencode: { kind: "agent", why: "Set it up from Getting started" },
  linear: { kind: "app", service: "linear", why: "Read issues so your AI can help with them" },
  jira: { kind: "app", service: "jira", why: "Read tickets so your AI can help with them" },
  figma: { kind: "app", service: "figma", why: "So your AI can read your designs" },
  gmail: { kind: "app", service: "gmail", why: "So your AI can sort and draft email" },
  outlook: { kind: "app", service: "microsoft_outlook", why: "So your AI can sort and draft email" },
  "google-calendar": { kind: "app", service: "google_calendar", why: "So your AI can plan around your day" },
  slack: { kind: "app", service: "slack", why: "So your AI can catch you up on threads" },
  notion: { kind: "app", service: "notion", why: "So your AI can use your notes and docs" },
  stripe: { kind: "app", service: "stripe", why: "So your AI can answer questions about payments" },
  hubspot: { kind: "app", service: "hubspot", why: "So your AI can keep track of your customers" },
  telegram: { kind: "channel", why: "Set up in Settings once you're in" },
  whatsapp: { kind: "channel", why: "Set up in Settings once you're in" },
  discord: { kind: "app", service: "discord", why: "So your AI can reach you on Discord" },
  email: { kind: "channel", why: "Set up in Settings once you're in" },
  todoist: { kind: "app", service: "todoist", why: "So your AI can add and check your tasks" },
};

const TOOL_LABELS = new Map<GetStartedToolId, string>(
  GET_STARTED_TOOL_GROUPS.flatMap((group) => group.tools.map((tool) => [tool.id, tool.label] as const)),
);

// Suggested integrations per goal, after the goal's own tools; services the
// computer cannot connect are simply not in its catalog.
const SUGGESTIONS: Record<GetStartedGoalId | "none", readonly GetStartedToolId[]> = {
  code: ["figma", "slack", "github"],
  business: ["gmail", "google-calendar", "slack"],
  assistant: ["google-calendar", "gmail", "todoist"],
  build: ["github", "notion"],
  explore: ["gmail", "google-calendar"],
  none: ["gmail", "google-calendar"],
};

/** The display name for an integration service id, from the same catalog as the connect list. */
export function getStartedServiceLabel(service: string): string {
  for (const [tool, connect] of Object.entries(TOOL_CONNECT) as [GetStartedToolId, GetStartedToolConnect][]) {
    if (connect.kind === "app" && connect.service === service) return TOOL_LABELS.get(tool) ?? service;
  }
  return service;
}

export function getStartedToolConnect(tool: GetStartedToolId): GetStartedToolConnect {
  return TOOL_CONNECT[tool];
}

/** The tool a connected integration service stands for, if the wizard's catalog has one. */
export function getStartedToolForService(service: string): GetStartedToolId | undefined {
  for (const [tool, connect] of Object.entries(TOOL_CONNECT) as [GetStartedToolId, GetStartedToolConnect][]) {
    if (connect.kind === "app" && connect.service === service) return tool;
  }
  return undefined;
}

/** Integration services that fit the goals: each goal's own tools, then its suggestions, in goal order. */
export function getStartedConnectOrder(goals: readonly GetStartedGoalId[]): string[] {
  const tools = (goals.length > 0 ? goals : (["none"] as const)).flatMap((goal) => [
    ...(GET_STARTED_TOOL_GROUPS.find((group) => group.goal === goal)?.tools.map((tool) => tool.id) ?? []),
    ...SUGGESTIONS[goal],
  ]);
  const services = tools.flatMap((tool) => {
    const connect = TOOL_CONNECT[tool];
    return connect.kind === "app" ? [connect.service] : [];
  });
  return [...new Set(services)];
}

/** What connecting a service is for, when the wizard's catalog knows it (customer feedback, spec 635). */
export function getStartedConnectBenefit(service: string): string | undefined {
  const tool = getStartedToolForService(service);
  return tool ? TOOL_CONNECT[tool].why : undefined;
}
