import { isManagedCustomBot, type ChatAgent, type ChatAgentListResponse, type InstantiateBotResponse } from "@matrix-os/contracts";
import type { AgentDraft } from "./AgentEditor.js";
import type { ChatAgentClient } from "./client.js";
import { agentRecipePatch } from "./recipe-edit.js";

export function agentDraftMatchesSaved(draft: AgentDraft, agent: ChatAgent) {
  return draft.name === agent.name && draft.description === agent.description && draft.instructions === agent.instructions
    && JSON.stringify(draft.selection) === JSON.stringify(agent.selection) && !Object.keys(agentRecipePatch(agent, draft.recipe)).length;
}

/** A promoted definition needs the server's exact unfinished operation projection. */
export function savedAgentRecoveryBaseRevision(agent: ChatAgent, recoveries: ChatAgentListResponse["managedCustomRecoveries"]) {
  if (agent.archived || agent.selection.instanceId !== "matrix_pi_default" || agent.selection.options?.length) return undefined;
  return recoveries?.find(recovery => recovery.agentId === agent.id)?.baseRevision ?? (!agent.recipeRef ? agent.revision : undefined);
}

export async function recoverSavedFundedBot(client: ChatAgentClient, retained: { current: InstantiateBotResponse | null },
  agent: ChatAgent, draft: AgentDraft, isCurrent: () => boolean, unfinishedBaseRevision?: number) {
  if (!isCurrent() || !agentDraftMatchesSaved(draft, agent) || !client.bots?.recoverManagedCustom)
    throw new Error("Saved Bot recovery unavailable");
  if (!retained.current) {
    const result = await client.bots.recoverManagedCustom(agent.id, { baseRevision: unfinishedBaseRevision ?? agent.revision });
    if (result.agent.id !== agent.id) throw new Error("Recovered Bot identity did not match");
    retained.current = result;
  }
  if (!isCurrent()) throw new Error("Bot recovery ended");
  const recovered = retained.current;
  // Recovery promotes an existing definition; the old editor snapshot is not
  // edit intent. Read back by identity without overwriting later owner edits.
  const saved = (await client.list()).agents.find(candidate => candidate.id === recovered.agent.id);
  if (!isCurrent()) throw new Error("Bot recovery ended");
  if (!saved || !isManagedCustomBot(saved) || saved.archived) throw new Error("Recovered Bot readback unavailable");
  return { saved, chatId: recovered.chatId };
}
