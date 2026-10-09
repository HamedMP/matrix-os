import type { ChatAgent } from "#chat-agents";
import type { CanonicalChatModelSelection } from "#canonical-chat";
import type { CanonicalProviderCatalog } from "#canonical-chat-provider";
import { MATRIX_BOT_SELECTION } from "#bots/selection";
import { botModelRoutingLabel, canonicalProviderModelRouteLabel, isLegacyMatrixSdkProvider } from "#bots/model-choice";

export type BotExecutionPresentation = {
  kind: "recipe" | "custom";
  selection: CanonicalChatModelSelection;
  interactionMode: string;
  permissionMode: string;
  available: boolean;
  requiresFullAccess: boolean;
  modelLabel: string;
};

/** Dedicated identity does not imply a Pi executor or authorize Full access. */
export function botExecutionPresentation(agent: Pick<ChatAgent, "recipeRef" | "selection">,
  catalog?: CanonicalProviderCatalog | null): BotExecutionPresentation {
  if (agent.recipeRef) return { kind: "recipe", selection: MATRIX_BOT_SELECTION,
    interactionMode: "default", permissionMode: "default", available: true,
    requiresFullAccess: false, modelLabel: botModelRoutingLabel(agent.selection, catalog) };
  const instance = catalog?.instances.find(candidate => candidate.id === agent.selection.instanceId);
  const model = instance?.models.find(candidate => candidate.id === agent.selection.model);
  const available = Boolean(instance && !isLegacyMatrixSdkProvider(instance) && instance.availability === "available" && model?.availability === "available");
  const modes = instance?.supports.permissionModes ?? [];
  const permissionMode = modes.includes("supervised") ? "supervised" : modes.includes("default") ? "default" : "default";
  return { kind: "custom", selection: agent.selection, interactionMode: "default", permissionMode,
    available, requiresFullAccess: modes.includes("full_access") && !modes.includes(permissionMode),
    modelLabel: `${canonicalProviderModelRouteLabel(instance, model?.displayName ?? agent.selection.model)}${available ? "" : " · unavailable"}` };
}
