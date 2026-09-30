import type { BotAuthorityView, BotConnectionState } from "#bots/authority";
import type { BotGrant } from "#bots/grants";
import type { BotInteraction, BotInteractionKind } from "#bots/interactions";
import type { BotBlockedReason, BotTaskStatus, BotTaskSummary } from "#bots/tasks";

export type BotInteractionCardState = "actionable" | "unavailable" | "expired" | "resolved" | "cancelled";

const interactionCopy: Record<BotInteractionKind, { title: string; actionLabel: string }> = {
  question: { title: "Question", actionLabel: "Answer" },
  account_choice: { title: "Choose an account", actionLabel: "Choose" },
  connect_request: { title: "Connect a service", actionLabel: "Connect" },
  approval: { title: "Approval requested", actionLabel: "Review" },
};

/** One shared derivation for every Chat surface. A hidden payload cannot be acted on. */
export function botInteractionCard(interaction: BotInteraction, now: string): {
  state: BotInteractionCardState;
  title: string;
  actionLabel: string | null;
} {
  const state: BotInteractionCardState = interaction.status !== "pending" ? interaction.status
    : interaction.expiresAt <= now ? "expired"
      : !interaction.payload ? "unavailable" : "actionable";
  return {
    state,
    title: interactionCopy[interaction.kind].title,
    actionLabel: state === "actionable" ? interactionCopy[interaction.kind].actionLabel : null,
  };
}

/** Keep the server's connection order, then show any grant with a missing inventory row. */
export function groupBotAuthority(view: BotAuthorityView): Array<BotConnectionState & { grants: BotGrant[] }> {
  const connections = view.connections.map((connection) => ({
    ...connection,
    grants: view.grants.filter((grant) => grant.service === connection.service),
  }));
  for (const grant of view.grants) {
    if (!connections.some((connection) => connection.service === grant.service)) {
      connections.push({ service: grant.service, state: "granted", grants: view.grants.filter((candidate) => candidate.service === grant.service) });
    }
  }
  return connections;
}

const statusCopy: Record<BotTaskStatus, string> = {
  queued: "Queued", running: "Working", waiting_person: "Waiting for your answer",
  waiting_capacity: "Waiting for capacity", blocked: "Needs attention",
  completed: "Completed", failed: "Could not finish", cancelled: "Cancelled",
};

const blockedCopy: Record<BotBlockedReason, string> = {
  root_unavailable: "Workspace unavailable",
  grant_revoked: "Access was removed",
  budget_exhausted: "Budget exhausted",
  tool_unavailable: "Tool unavailable",
  model_unavailable: "Model unavailable",
  funds_unavailable: "Funds unavailable",
  capacity_unavailable: "Capacity unavailable",
  deadline_reached: "Time limit reached",
  policy_denied: "Action blocked by policy",
};

export function botTaskStatusCopy(task: BotTaskSummary): string {
  return task.status === "blocked" && task.blockedReason ? blockedCopy[task.blockedReason] : statusCopy[task.status];
}

/** Presentation only: these labels never change a grant or connection state. */
export function botServiceLabel(service: string): string {
  const labels: Record<string, string> = { gmail: "Gmail", google_calendar: "Google Calendar", slack: "Slack", notion: "Notion", github: "GitHub" };
  return labels[service] ?? service.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function botConnectionStateLabel(state: BotConnectionState["state"]): string {
  return { granted: "Access allowed", connected_not_granted: "Connected · no access", not_connected: "Not connected" }[state];
}

export function botAccessLabel(effects: readonly string[]): string {
  return effects.map((effect) => effect.charAt(0).toUpperCase() + effect.slice(1).replaceAll("_", " ")).join(", ");
}

export type BotSettingsSection = "connections" | "memory" | "routines";

/** The same onboarding guidance in every settings renderer; it grants no access. */
export const botSettingsEmptyStates = {
  connections: { title: "No connections yet", description: "Connections let this bot work with your services.",
    hint: "Ask your bot to use a service. It will request access when needed." },
  memory: { title: "Nothing remembered yet", description: "Save preferences so this bot can tailor its replies.",
    hint: 'Try saying "Remember that I prefer short summaries."' },
  routines: { title: "No routines yet", description: "Routines help this bot repeat work on a schedule.",
    hint: "Ask your bot to schedule a recurring task." },
} as const;
