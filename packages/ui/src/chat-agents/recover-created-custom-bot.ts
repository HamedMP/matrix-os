import { isManagedCustomBot, type ChatAgent, type InstantiateBotResponse } from '@matrix-os/contracts';
import type { ChatAgentClient } from './client.js';
import type { AgentDraft } from './AgentEditor.js';
import { agentRecipePatch } from './recipe-edit.js';

/** Once creation commits, recovery edits that definition instead of creating another Bot. */
export async function recoverCreatedCustomBot(client: ChatAgentClient, created: InstantiateBotResponse, draft: AgentDraft): Promise<ChatAgent> {
  const agent = (await client.list()).agents.find(candidate => candidate.id === created.agent.id);
  if (!agent || !isManagedCustomBot(agent) || agent.archived || !draft.selection) throw new Error('Created Bot readback unavailable');
  // A retained new-editor draft is a full snapshot: omitted recipe means removed.
  const recipe = agentRecipePatch(agent, draft.recipe === undefined && agent.recipe ? null : draft.recipe);
  const selection = JSON.stringify(draft.selection) === JSON.stringify(agent.selection) ? {} : { selection: draft.selection };
  if (draft.name === agent.name && draft.description === agent.description && draft.instructions === agent.instructions
    && !Object.keys(recipe).length && !Object.keys(selection).length) return agent;
  return client.update(agent.id, { name: draft.name, description: draft.description, instructions: draft.instructions,
    baseRevision: agent.revision, ...selection, ...recipe });
}
