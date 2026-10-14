import type { CanonicalChatModelSelection, ChatAgentRecipe } from "@matrix-os/contracts";
import { copyEditableAgentRecipe } from "./recipe-edit.js";

/** The editable configuration. Request identity changes only with configuration. */
export type AgentDraft = {
  name: string;
  description: string;
  instructions: string;
  selection: CanonicalChatModelSelection | null;
  requestId: string;
  recipe?: ChatAgentRecipe | null;
  taskExecutor?: { connectionId: "claude_code_tasks"; model: string | null } | null;
  coordinatorInstanceId?: string | null;
};
export type AgentDraftChange = Partial<Omit<AgentDraft, "requestId">>;

/** Accept incomplete drafts without parsing away optional/unset fields or account intent. */
export function copyAgentDraft(draft: AgentDraft): AgentDraft {
  return {
    name: draft.name, description: draft.description, instructions: draft.instructions,
    requestId: draft.requestId,
    selection: draft.selection ? { ...draft.selection,
      ...(Object.hasOwn(draft.selection, "options") ? { options: draft.selection.options?.map(option => ({ ...option })) } : {}),
    } : null,
    ...(Object.hasOwn(draft, "taskExecutor") ? { taskExecutor: draft.taskExecutor ? { ...draft.taskExecutor } : draft.taskExecutor } : {}),
    ...(Object.hasOwn(draft, "coordinatorInstanceId") ? { coordinatorInstanceId: draft.coordinatorInstanceId } : {}),
    ...(Object.hasOwn(draft, "recipe") ? {
      recipe: draft.recipe ? copyEditableAgentRecipe(draft.recipe) : draft.recipe,
    } : {}),
  };
}

function sameSelection(left: AgentDraft["selection"], right: AgentDraft["selection"]): boolean {
  if (left === null || right === null) return left === right;
  return left.instanceId === right.instanceId && left.model === right.model
    && (left.options === undefined || right.options === undefined ? left.options === right.options
      : left.options.length === right.options.length && left.options.every((option, index) =>
        option.id === right.options![index]!.id && option.value === right.options![index]!.value));
}

function sameRecipe(left: AgentDraft["recipe"], right: AgentDraft["recipe"]): boolean {
  if (!left || !right) return left === right;
  return left.output === right.output && left.jevInboxLabeling === right.jevInboxLabeling
    && left.skills.length === right.skills.length && left.skills.every((skill, index) => skill === right.skills[index])
    && left.integrations.length === right.integrations.length && left.integrations.every((integration, index) =>
      integration.service === right.integrations[index]!.service && integration.accountLabel === right.integrations[index]!.accountLabel);
}

export function patchAgentDraft(draft: AgentDraft, change: AgentDraftChange, newRequestId: () => string): AgentDraft {
  const next = copyAgentDraft({ ...draft, ...change });
  if (draft.name === next.name && draft.description === next.description && draft.instructions === next.instructions
    && sameSelection(draft.selection, next.selection) && sameRecipe(draft.recipe, next.recipe)
    && Object.hasOwn(draft, "recipe") === Object.hasOwn(next, "recipe")
    && draft.coordinatorInstanceId === next.coordinatorInstanceId
    && (draft.taskExecutor == null || next.taskExecutor == null ? draft.taskExecutor === next.taskExecutor
      : draft.taskExecutor.connectionId === next.taskExecutor.connectionId && draft.taskExecutor.model === next.taskExecutor.model)) return draft;
  return { ...next, requestId: newRequestId() };
}
