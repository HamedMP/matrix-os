import {
  GET_STARTED_TOOL_GROUPS,
  type GetStartedAnswers,
  type GetStartedGoalId,
  type GetStartedToolId,
} from "#get-started";

// Spec 635, Section 4: what the wizard's last screen offers to connect. Only
// apps from the computer's own integration catalog get a Connect button; agent
// sign-ins and messaging channels stay informational and remain in Getting
// started. Service ids are fixed here, never taken from the client.

export const GET_STARTED_CONNECT_MAX_PICKED = 4;
export const GET_STARTED_CONNECT_MAX_SUGGESTED = 2;

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

const SUGGESTIONS: Record<GetStartedGoalId | "none", { title: string; tools: readonly GetStartedToolId[] }> = {
  code: { title: "Popular with developers", tools: ["figma", "slack", "github"] },
  business: { title: "Popular for running a business", tools: ["gmail", "google-calendar", "slack"] },
  assistant: { title: "Popular for a personal assistant", tools: ["google-calendar", "gmail", "todoist"] },
  build: { title: "Popular for building apps", tools: ["github", "notion"] },
  explore: { title: "Popular to start with", tools: ["gmail", "google-calendar"] },
  none: { title: "Popular to start with", tools: ["gmail", "google-calendar"] },
};

export interface GetStartedConnectRow {
  tool: GetStartedToolId;
  label: string;
  why: string;
  kind: GetStartedToolConnect["kind"];
  /** Present only for apps the computer can connect. */
  service?: string;
}

export interface GetStartedConnectPlan {
  rows: GetStartedConnectRow[];
  suggestionTitle: string | null;
  suggestions: GetStartedConnectRow[];
}

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

function row(tool: GetStartedToolId, available: ReadonlySet<string>): GetStartedConnectRow | null {
  const connect = TOOL_CONNECT[tool];
  const label = TOOL_LABELS.get(tool) ?? tool;
  if (connect.kind !== "app") return { tool, label, why: connect.why, kind: connect.kind };
  if (!available.has(connect.service)) return null;
  return { tool, label, why: connect.why, kind: "app", service: connect.service };
}

/** Picked tools first (capped), then two connectable suggestions for the first goal. */
export function getStartedConnectPlan(answers: GetStartedAnswers, available: ReadonlySet<string>): GetStartedConnectPlan {
  const rows = answers.tools
    .map((tool) => row(tool, available))
    .filter((candidate): candidate is GetStartedConnectRow => candidate !== null)
    .slice(0, GET_STARTED_CONNECT_MAX_PICKED);
  const picked = new Set(answers.tools);
  const source = SUGGESTIONS[answers.goals[0] ?? "none"];
  const suggestions = source.tools
    .filter((tool) => !picked.has(tool))
    .map((tool) => row(tool, available))
    .filter((candidate): candidate is GetStartedConnectRow => candidate?.kind === "app")
    .slice(0, GET_STARTED_CONNECT_MAX_SUGGESTED);
  return { rows, suggestionTitle: suggestions.length > 0 ? source.title : null, suggestions };
}
