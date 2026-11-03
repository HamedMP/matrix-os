import { isManagedCustomBot, type ChatAgent, type InstantiateBotResponse } from '@matrix-os/contracts';
import type { ChatAgentClient } from './client.js';
import type { AgentDraft } from './AgentEditor.js';
import { agentRecipePatch } from './recipe-edit.js';

/** Once creation commits, recovery edits that definition instead of creating another Bot. */
export async function recoverCreatedCustomBot(client: ChatAgentClient, created: InstantiateBotResponse, draft: AgentDraft,
  isCurrent: () => boolean = () => true): Promise<ChatAgent> {
  return recoverCreatedAgent(client, created.agent.id, draft, true, isCurrent);
}

export async function recoverCreatedAgent(client: ChatAgentClient, agentId: string, draft: AgentDraft,
  managed: boolean, isCurrent: () => boolean = () => true): Promise<ChatAgent> {
  if (!isCurrent()) throw new Error('Agent setup ended');
  const agent = (await client.list()).agents.find(candidate => candidate.id === agentId);
  if (!isCurrent()) throw new Error('Agent setup ended');
  if (!agent || (managed && !isManagedCustomBot(agent)) || agent.archived || !draft.selection) throw new Error('Created Bot readback unavailable');
  // A retained new-editor draft is a full snapshot: omitted recipe means removed.
  const recipe = agentRecipePatch(agent, draft.recipe === undefined && agent.recipe ? null : draft.recipe);
  const selection = JSON.stringify(draft.selection) === JSON.stringify(agent.selection) ? {} : { selection: draft.selection };
  if (draft.name === agent.name && draft.description === agent.description && draft.instructions === agent.instructions
    && !Object.keys(recipe).length && !Object.keys(selection).length) return agent;
  return client.update(agent.id, { name: draft.name, description: draft.description, instructions: draft.instructions,
    baseRevision: agent.revision, ...selection, ...recipe });
}
