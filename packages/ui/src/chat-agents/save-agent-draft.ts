import { MATRIX_CHATGPT_PLAN_INSTANCE_ID, type ChatAgent, type CreateChatAgentRequest, type InstantiateBotResponse } from "@matrix-os/contracts";
import type { AgentDraft } from "./AgentEditor.js";
import type { ChatAgentClient } from "./client.js";
import { agentRecipePatch } from "./recipe-edit.js";
import { recoverCreatedAgent } from "./recover-created-custom-bot.js";
import { safeHttpStatus } from "./safe-http-status.js";

export type AgentCreationAttempt = { client: ChatAgentClient; input: CreateChatAgentRequest; managed: boolean;
  result?: InstantiateBotResponse; agent?: ChatAgent; chatId?: string; uncertainOutcome?: boolean };

function matchesSavedDraft(draft: AgentDraft, agent: ChatAgent): boolean {
  const recipe = draft.recipe === undefined && agent.recipe ? null : draft.recipe;
  return draft.name === agent.name && draft.description === agent.description && draft.instructions === agent.instructions
    && JSON.stringify(draft.selection) === JSON.stringify(agent.selection) && !Object.keys(agentRecipePatch(agent, recipe)).length;
}

/** An uncertain response replays the exact original request, then edits its verified identity. */
export async function saveAgentDraft(client: ChatAgentClient, retained: { current: AgentCreationAttempt | null },
  draft: AgentDraft, editing: ChatAgent | "new", isCurrent: () => boolean = () => true) {
  if (!draft.selection || !isCurrent()) throw new Error("Agent setup unavailable");
  const fields = { name: draft.name, description: draft.description, instructions: draft.instructions };
  if (editing !== "new") return { saved: await client.update(editing.id, { ...fields, baseRevision: editing.revision,
    ...(JSON.stringify(draft.selection) === JSON.stringify(editing.selection) ? {} : { selection: draft.selection }),
    ...agentRecipePatch(editing, draft.recipe) }), managed: Boolean(editing.recipeRef) };
  if (retained.current?.client !== client) retained.current = null;
  if (!retained.current) {
    const managed = !draft.recipe?.skills.includes("matrix-jev-email-triage")
      && Boolean(client.bots?.createCustom) && ["matrix_pi_default", MATRIX_CHATGPT_PLAN_INSTANCE_ID].includes(draft.selection.instanceId);
    retained.current = { client, managed, input: { ...fields, selection: draft.selection, clientRequestId: draft.requestId,
      ...(draft.recipe ? { recipe: draft.recipe } : {}) } };
  }
  const attempt = retained.current;
  if (!attempt.agent && !attempt.result) {
    try {
      if (attempt.managed) attempt.result = await client.bots!.createCustom!(attempt.input);
      else attempt.agent = await client.create(attempt.input);
    } catch (failure: unknown) {
      // A first validation/auth rejection happens before writes. Once any request
      // may have committed, later validation failures cannot disprove that operation.
      // Capacity errors can also follow definition/workspace creation.
      const status = safeHttpStatus(failure);
      if (!attempt.uncertainOutcome && status !== null && [400, 401, 403, 404, 413, 422].includes(status)) retained.current = null;
      else attempt.uncertainOutcome = true;
      throw failure;
    }
  }
  if (!isCurrent()) throw new Error("Agent setup ended");
  const id = attempt.result?.agent.id ?? attempt.agent!.id;
  const saved = !attempt.managed && attempt.agent && matchesSavedDraft(draft, attempt.agent)
    ? attempt.agent : await recoverCreatedAgent(client, id, draft, attempt.managed, isCurrent);
  if (!saved || !isCurrent()) throw new Error("Created Bot readback unavailable");
  attempt.agent = saved;
  if (attempt.result) attempt.chatId = attempt.result.chatId;
  return { saved, managed: attempt.managed, attempt };
}
