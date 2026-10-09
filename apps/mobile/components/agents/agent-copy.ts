import {
  botExecutionPresentation,
  isAutomaticBotSelection,
  type BotAuthorityView,
  type BotInteractionPayload,
  type CanonicalProviderCatalog,
  type ChatAgent,
} from "@matrix-os/contracts";

export type ApprovalPayload = Extract<BotInteractionPayload, { kind: "approval" }>;
type ConnectionState = BotAuthorityView["connections"][number]["state"];

function capitalized(word: string): string {
  return word ? `${word[0].toUpperCase()}${word.slice(1)}` : word;
}

/** The server names a service by its slug (`google_calendar`), never by a display name. */
export function serviceLabel(service: string): string {
  return service.split("_").map(capitalized).join(" ");
}

/**
 * What an approval is for, as "<action> · <target>". With an account the
 * action is its service and the target the account; without one the action is
 * the tool, and the target a shared chat when that is where the agent acts.
 */
export function approvalTitle({ tool, account, audience }: Pick<ApprovalPayload, "tool" | "account" | "audience">): string {
  const action = account ? serviceLabel(account.service) : capitalized(tool.replace(/[._:-]+/g, " ").trim());
  const target = account ? account.label : audience === "direct" ? "" : "Shared chat";
  return [action, target].filter(Boolean).join(" · ");
}

const CONNECTION_STATUS: Record<ConnectionState, string> = {
  granted: "Connected",
  not_connected: "Not connected",
  connected_not_granted: "Connected, not granted",
};

export function connectionStatusLabel(state: ConnectionState): string {
  return CONNECTION_STATUS[state];
}

/**
 * "Runs on <engine> · <model> via <source>", from the agent's saved model and
 * what the computer lists for it. A part the computer does not list is left
 * out; null when it lists none of them.
 */
export function agentRunsOn(
  agent: Pick<ChatAgent, "recipeRef" | "selection">,
  catalog?: CanonicalProviderCatalog | null,
): string | null {
  if (botExecutionPresentation(agent, catalog).kind === "recipe" && isAutomaticBotSelection(agent.selection)) {
    return "Runs on Automatic";
  }
  const instance = catalog?.instances.find((candidate) => candidate.id === agent.selection.instanceId);
  if (!instance) return null;
  const engine = instance.driverKind === "matrix_pi" ? "Pi" : instance.displayName;
  const model = instance.models.find((candidate) => candidate.id === agent.selection.model)?.displayName;
  const source = instance.connectionLabel && instance.connectionLabel !== engine ? instance.connectionLabel : null;
  return `Runs on ${[engine, model].filter(Boolean).join(" · ")}${source ? ` via ${source}` : ""}`;
}
