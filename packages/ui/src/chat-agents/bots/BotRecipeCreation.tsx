import { useLayoutEffect, useMemo, useState } from "react";
import type { BotRecipeRef, BotRecipeSummary, CanonicalChatModelSelection, CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "../../canonical-provider-choice.js";
import { safeHttpStatus } from "../safe-http-status.js";
import { BotRecipeSetup, type RecipeConfiguration, type RecipeSetupResources } from "./BotRecipeSetup.js";
import type { BotExecutorSelection } from "./BotTaskExecutorField.js";
import type { BotClient } from "./client.js";
import { configureCreatedExecutor } from "./configure-created-executor.js";
import { botModelChoiceMatchesSelection, isAutomaticBotSelection, matrixBotSelectableModelChoices, matrixBotModelSelection } from "./MatrixBotModelField.js";

export type InstantiateRecipe = (recipe: BotRecipeRef, requestId: string, selection?: CanonicalChatModelSelection,
  name?: string, configuration?: RecipeConfiguration) => Promise<string>;
type RecipeAttempt = { requestId: string; chatId?: string; executorAttempted?: boolean; uncertain?: boolean };

export function BotRecipeCreation({ recipe, includeName, setupResources, botClient, models, catalog, catalogLoading = false,
  catalogUnavailable = false, onInstantiate, onOpen, onSetup, onRefreshCatalog, onClose }: {
  recipe: BotRecipeSummary; includeName?: boolean; setupResources?: RecipeSetupResources; botClient?: BotClient;
  models: readonly CanonicalProviderChoice[]; catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean; catalogUnavailable?: boolean;
  onInstantiate?: InstantiateRecipe; onOpen?: (chatId: string) => void | Promise<void>; onSetup?(): void; onRefreshCatalog?(): void; onClose(): void;
}) {
  const choices = matrixBotSelectableModelChoices(models, catalog);
  const [chosen, setChosen] = useState<CanonicalChatModelSelection | null | undefined>();
  // Initialize only once from the loaded catalog. Later refreshes preserve an explicit choice.
  if (chosen === undefined && !catalogLoading && choices[0]) setChosen(matrixBotModelSelection(choices[0]));
  const selection = chosen ?? null;
  const available = !catalogUnavailable && selection && (isAutomaticBotSelection(selection) || choices.some(choice => botModelChoiceMatchesSelection(choice, selection)));
  const transport = botClient ?? onInstantiate;
  const owner = useMemo(() => ({ active: false, busy: false, attempt: null as RecipeAttempt | null }), [transport]);
  const [operationState, setOperationState] = useState({ owner, pending: false, error: "" });
  const pending = operationState.owner === owner && operationState.pending;
  const error = operationState.owner === owner ? operationState.error : "";
  useLayoutEffect(() => {
    owner.active = true;
    return () => { owner.active = false; };
  }, [owner]);

  const create = async (name: string, executor?: BotExecutorSelection | null, configuration?: RecipeConfiguration) => {
    if (!onInstantiate || !onOpen || !owner.active || owner.busy || !selection || !owner.attempt?.chatId && (!available || catalogLoading)) return;
    const current = () => owner.active;
    const operation = owner.attempt ??= { requestId: `req_${crypto.randomUUID().replaceAll("-", "")}` };
    owner.busy = true;
    setOperationState({ owner, pending: true, error: "" });
    let failureMessage = "";
    try {
      if (!operation.chatId) {
        const ref = { recipeId: recipe.recipeId, version: recipe.version };
        const args: Parameters<InstantiateRecipe> = [ref, operation.requestId, selection];
        if (includeName || name !== recipe.name || configuration) args.push(name);
        if (configuration) args.push(configuration);
        operation.chatId = await onInstantiate(...args);
      }
      if (!current()) return;
      if (executor || operation.executorAttempted) {
        if (!botClient) throw new Error("Task execution unavailable");
        operation.executorAttempted = true;
        await configureCreatedExecutor(botClient, operation.chatId, executor ?? null, current, true);
      }
      if (!current()) return;
      await onOpen(operation.chatId);
      if (current()) onClose();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Recipe creation unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (!current()) return;
      const status = safeHttpStatus(failure);
      if (!operation.chatId) {
        if (!operation.uncertain && status !== null && [400, 401, 403, 404, 413, 422].includes(status)) owner.attempt = null;
        else operation.uncertain = true;
      }
      failureMessage = operation.chatId ? "Your bot was created. Task setup could not complete. Retry to continue."
        : operation.uncertain ? "Creation could not be confirmed. Retry to finish the same bot." : "Bot could not be created. Try again.";
    } finally {
      owner.busy = false;
      if (current()) setOperationState({ owner, pending: false, error: failureMessage });
    }
  };
  return <BotRecipeSetup setupResources={setupResources} onRefreshCatalog={onRefreshCatalog} onSetup={onSetup} botClient={botClient}
    creationRetained={Boolean(owner.attempt?.chatId)} creationUncertain={owner.attempt?.uncertain} recipe={recipe}
    selection={selection} models={models} catalog={catalog} catalogLoading={catalogLoading} catalogUnavailable={catalogUnavailable}
    pending={pending} createDisabled={!onInstantiate || !onOpen || !owner.attempt?.chatId && (!available || catalogLoading)}
    error={error} onSelectionChange={value => { setChosen(value); setOperationState({ owner, pending: false, error: "" }); }} onCreate={create} onClose={onClose} />;
}
