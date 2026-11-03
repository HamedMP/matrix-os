import { ChatAgentInputFieldsSchema, ChatAgentRecipeSchema, isChatgptPlanBotRoute, isChatgptPlanChatRoute,
  isManagedCustomBot, isMatrixAnthropicBotRoute, isMatrixAnthropicChatRoute,
  type ChatAgent, type ChatAgentRecipeCatalog, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { AgentDraft } from "./AgentEditor.js";
import type { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { botModelChoiceMatchesSelection, isAutomaticBotSelection, matrixBotSelectableModelChoices } from "./bots/MatrixBotModelField.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import { editableAgentRecipe } from "./recipe-edit.js";

export function customAgentModelChoices(models: ReturnType<typeof deriveCanonicalProviderChoices>) {
  return models.filter(choice => !isChatgptPlanBotRoute(choice) && !isChatgptPlanChatRoute(choice)
    && !isMatrixAnthropicChatRoute(choice) && !isMatrixAnthropicBotRoute(choice));
}

/** One derivation owns visible feedback, button eligibility and native submission. */
export function agentEditorValidation({ draft, editing, models, catalog, catalogLoading = false, recipeCatalog, managedCreation = false, retainedSelection, retainedManaged }: {
  draft: AgentDraft; editing: ChatAgent | "new"; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean; recipeCatalog: ChatAgentRecipeCatalog | null; managedCreation?: boolean;
  retainedSelection?: CanonicalChatModelSelection; retainedManaged?: boolean;
}) {
  const recipeBot = editing !== "new" && Boolean(editing.recipeRef);
  const managedCustom = retainedManaged === true || (editing !== "new" && isManagedCustomBot(editing));
  const hermesOnly = draft.recipe?.skills.includes("matrix-jev-email-triage") === true;
  const editableRecipe = !recipeBot || managedCustom;
  const managedAgent = retainedManaged === false ? false : recipeBot || retainedManaged === true || (editing === "new" && !hermesOnly);
  const subscriptionNew = editing === "new" && retainedManaged !== false && !hermesOnly && managedCreation;
  const eligibleModels = managedAgent ? matrixBotSelectableModelChoices(models, catalog, recipeBot || subscriptionNew) : customAgentModelChoices(models);
  const selectionChanged = JSON.stringify(draft.selection) !== JSON.stringify(editing === "new" ? retainedSelection : editing.selection);
  const errors: Partial<Record<"name" | "description" | "instructions" | "model" | "output" | "recipe", string>> = {};
  if (!ChatAgentInputFieldsSchema.shape.name.safeParse(draft.name).success)
    errors.name = draft.name.trim() ? "Use a name of up to 80 characters without control characters." : "Enter a name.";
  if (!ChatAgentInputFieldsSchema.shape.description.safeParse(draft.description).success) errors.description = "Use a description of up to 400 characters.";
  if (!ChatAgentInputFieldsSchema.shape.instructions.safeParse(draft.instructions).success)
    errors.instructions = draft.instructions.trim() ? "Shorten the instructions to fit the supported size." : "Enter instructions for this Agent.";
  if (catalogLoading && selectionChanged) errors.model = "Wait for models to finish loading.";
  else if (selectionChanged && !eligibleModels.some(choice => botModelChoiceMatchesSelection(choice, draft.selection))
    && !(recipeBot && isAutomaticBotSelection(draft.selection))) errors.model = "Choose an available supported model, or refresh models and try again.";
  const targetManaged = managedCreation && !hermesOnly && ["matrix_pi_default", "matrix_chatgpt_plan"].includes(draft.selection?.instanceId ?? "");
  if (editing === "new" && retainedManaged !== undefined && retainedManaged !== targetManaged)
    errors.model = "Restore the original model to finish this Bot safely. After setup, change its model through the supported Bot settings.";
  if (editableRecipe && draft.recipe) {
    const parsed = ChatAgentRecipeSchema.safeParse(draft.recipe);
    if (!parsed.success) {
      if (parsed.error.issues.some(issue => issue.path[0] === "output")) errors.output = draft.recipe.output.trim()
        ? "Use an expected output of up to 1,000 characters without unsupported characters."
        : "Describe the expected output for this recipe.";
      if (parsed.error.issues.some(issue => issue.path[0] !== "output")) errors.recipe = "Review the recipe skills and integration choices. Remove invalid or duplicate selections.";
    }
    const recipeChanged = editing === "new" || JSON.stringify(draft.recipe) !== JSON.stringify(editableAgentRecipe(editing));
    if (recipeChanged && draft.recipe.skills.some(id => !recipeCatalog?.skills.some(skill => skill.id === id)))
      errors.recipe = "A selected skill is unavailable. Refresh recipe options or remove the unavailable skill.";
    if (!recipeSkillsFit(draft.recipe.skills, recipeCatalog?.skills ?? [])) errors.recipe = "These skills are too large to use together. Remove a selected skill.";
    if (managedCustom && hermesOnly) errors.recipe = "Remove the unavailable skill before saving this bot.";
  }
  return { errors, valid: Object.keys(errors).length === 0, recipeBot, managedCustom, editableRecipe, hermesOnly, managedAgent, subscriptionNew };
}
