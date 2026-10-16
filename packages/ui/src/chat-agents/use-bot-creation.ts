import { useEffect, useRef, useState } from "react";
import { ChatAgentRecipeSchema, type CanonicalProviderCatalog,
  type ChatAgentRecipeCatalog, type InstantiateBotResponse } from "@matrix-os/contracts";
import type { CanonicalProviderChoice } from "../canonical-provider-choice.js";
import { copyAgentDraft, patchAgentDraft, type AgentDraft } from "./agent-draft.js";
import type { BotCreationSeed, BotCreationChange } from "./BotCreationChat.js";
import type { ChatAgentClient } from "./client.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import { recoverCreatedCustomBot } from "./recover-created-custom-bot.js";
import { configureCreatedExecutor } from "./bots/configure-created-executor.js";
import { botModelChoiceMatchesSelection, isAutomaticBotSelection, matrixBotModelSelection, matrixBotSelectableModelChoices } from "./bots/MatrixBotModelField.js";

const requestId = () => `req_${crypto.randomUUID().replaceAll("-", "")}`;
type Phase = "editing" | "saving" | "configuring" | "opening" | "ready";
type Attempt = { instantiated?: InstantiateBotResponse; managed?: InstantiateBotResponse; chatId?: string;
  definitionKey?: string; creationRequest?: { key: string; id: string }; executorAttempted?: boolean };
// Executor/source-picker intent is separate from the persisted definition and its admission.
const definitionKey = (draft: AgentDraft) => JSON.stringify({ name: draft.name, description: draft.description,
  instructions: draft.instructions, selection: draft.selection, recipe: draft.recipe ?? null });

export function useBotCreation({ seed, client, models, catalog, catalogLoading, recipeCatalog, onOpen, onPendingChange }: {
  seed: BotCreationSeed; client: ChatAgentClient; models: readonly CanonicalProviderChoice[];
  catalog: CanonicalProviderCatalog | null; catalogLoading: boolean; recipeCatalog: ChatAgentRecipeCatalog | null;
  onOpen?: (chatId: string) => void | Promise<void>;
  onPendingChange?: (pending: boolean) => void;
}) {
  const creationModels = models;
  const initialChoice = matrixBotSelectableModelChoices(creationModels, catalog, !!client.bots?.createCustom).find(choice => choice.instanceId === "matrix_pi_default");
  const [value, setValue] = useState(() => ({ revision: 0, draft: copyAgentDraft({
    name: seed.kind === "recipe" ? seed.recipe.name : seed.kind === "inspiration" ? seed.inspiration.name : "",
    description: seed.kind === "recipe" ? seed.recipe.description : seed.kind === "inspiration" ? seed.inspiration.description : "",
    instructions: "", selection: initialChoice ? matrixBotModelSelection(initialChoice) : null, requestId: requestId(), taskExecutor: null,
  }) }));
  const valueRef = useRef(value), mounted = useRef(false), busy = useRef(false), selectedOnce = useRef(Boolean(initialChoice));
  const [sessionId] = useState(() => `draft_${crypto.randomUUID().replaceAll("-", "")}`);
  const attempt = useRef<Attempt>({});
  const [seedEditable, setSeedEditable] = useState(seed.kind !== "recipe");
  const [seedLoading, setSeedLoading] = useState(seed.kind === "recipe" && !!client.bots?.creationSeed), [seedReady, setSeedReady] = useState(seed.kind !== "recipe");
  const [pending, setPending] = useState(false), [error, setError] = useState(seed.kind === "recipe" && !client.bots?.creationSeed ? "Template configuration is unavailable. Try again after this computer is updated." : ""), [phase, setPhase] = useState<Phase>("editing");
  const isCurrent = () => mounted.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (selectedOnce.current || !initialChoice || !isCurrent()) return;
    selectedOnce.current = true;
    const next = { ...valueRef.current, draft: copyAgentDraft({ ...valueRef.current.draft, selection: matrixBotModelSelection(initialChoice) }) };
    valueRef.current = next; setValue(next);
  }, [initialChoice]);
  useEffect(() => {
    if (seed.kind !== "recipe") return;
    let current = true;
    if (!client.bots?.creationSeed) return;
    void client.bots.creationSeed({ recipeId: seed.recipe.recipeId, version: seed.recipe.version }).then(result => {
      if (!current || !isCurrent()) return;
      if (result.recipe.recipeId !== seed.recipe.recipeId || result.recipe.version !== seed.recipe.version) throw new Error("Template changed");
      const next = { ...valueRef.current, draft: copyAgentDraft({ ...valueRef.current.draft, ...result.draft }) };
      if (typeof result.editable !== "boolean") throw new Error("Template eligibility unavailable");
      valueRef.current = next; setValue(next); setSeedEditable(result.editable); setSeedReady(true); setSeedLoading(false);
    }).catch((failure: unknown) => {
      console.warn("[bot-creation] Template unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current && isCurrent()) { setSeedLoading(false); setError("Template configuration is unavailable. Return to templates and try again."); }
    });
    return () => { current = false; };
  }, [client, seed]);
  const applyDraftChange = (expectedRevision: number, patch: BotCreationChange): boolean => {
    const current = valueRef.current;
    if (!isCurrent() || busy.current || !seedReady || current.revision !== expectedRevision) return false;
    const sourceFor = (selection: NonNullable<AgentDraft["selection"]>) => isAutomaticBotSelection(selection) ? "computer" : selection.instanceId;
    if (patch.coordinatorInstanceId != null) {
      const selection = Object.hasOwn(patch, "selection") ? patch.selection : current.draft.selection;
      if (selection && sourceFor(selection) !== patch.coordinatorInstanceId) {
        if (Object.hasOwn(patch, "selection")) { setError("Choose a model for the selected connection."); return false; }
        patch = { ...patch, selection: null };
      }
    } else if (patch.selection && current.draft.coordinatorInstanceId != null) {
      patch = { ...patch, coordinatorInstanceId: sourceFor(patch.selection) };
    }
    if (seed.kind === "recipe" && !seedEditable) {
      if ((patch.instructions !== undefined && patch.instructions !== current.draft.instructions)
        || (patch.description !== undefined && patch.description !== current.draft.description)
        || (Object.hasOwn(patch, "recipe") && JSON.stringify(patch.recipe) !== JSON.stringify(current.draft.recipe))) {
        setError("This template keeps its required apps and default instructions. Choose its name, model and task executor."); return false;
      }
      if (attempt.current.instantiated && (Object.hasOwn(patch, "name") || Object.hasOwn(patch, "selection"))) {
        setError("This template was saved. Retry opening its Chat or continue task setup."); return false;
      }
    }
    if (Object.hasOwn(patch, "selection") || Object.hasOwn(patch, "coordinatorInstanceId")) selectedOnce.current = true;
    const draft = patchAgentDraft(current.draft, patch, requestId);
    if (draft !== current.draft) {
      const next = { revision: current.revision + 1, draft };
      valueRef.current = next; setValue(next);
    }
    setError(""); return true;
  };
  const draft = value.draft;
  const selectable = matrixBotSelectableModelChoices(creationModels, catalog, !!(seed.kind === "recipe" && !seedEditable ? client.bots?.instantiate : client.bots?.createCustom) || seed.kind === "recipe");
  const selectionAvailable = Boolean(draft.selection && (selectable.some(choice => botModelChoiceMatchesSelection(choice, draft.selection))
    || (seed.kind === "recipe" && isAutomaticBotSelection(draft.selection))));
  const validRecipe = (seed.kind === "recipe" && !seedEditable) || !draft.recipe || (ChatAgentRecipeSchema.safeParse(draft.recipe).success && recipeSkillsFit(draft.recipe.skills, recipeCatalog?.skills ?? []));
  const configurationReady = !!draft.name.trim() && !!draft.selection && !!draft.instructions.trim()
    && validRecipe && (!draft.taskExecutor || !!draft.taskExecutor.model);
  const definitionUnchanged = attempt.current.definitionKey === definitionKey(draft);
  const definitionExists = !!(attempt.current.instantiated || attempt.current.managed || attempt.current.chatId);
  const needsDefinitionWrite = !definitionExists || (seedEditable && !definitionUnchanged);
  const disabled = pending || seedLoading || !seedReady || !(seed.kind === "recipe" && !seedEditable ? client.bots?.instantiate : client.bots?.createCustom) || !onOpen || !configurationReady
    || (needsDefinitionWrite && (catalogLoading || !selectionAvailable));
  const create = async () => {
    if (!isCurrent() || busy.current || disabled || !client.bots || !onOpen || !valueRef.current.draft.selection) return;
    busy.current = true; setPending(true); onPendingChange?.(true); setError("");
    const currentDraft = valueRef.current.draft, fields = { name: currentDraft.name, description: currentDraft.description,
      instructions: currentDraft.instructions, selection: currentDraft.selection!, ...(currentDraft.recipe ? { recipe: currentDraft.recipe } : {}) };
    const key = definitionKey(currentDraft);
    if (attempt.current.creationRequest?.key !== key) attempt.current.creationRequest = { key, id: currentDraft.requestId };
    const creationRequestId = attempt.current.creationRequest.id;
    try {
      if (seed.kind === "recipe" && !seedEditable) {
        if (!attempt.current.instantiated) {
          setPhase("saving");
          const instantiated = await client.bots.instantiate({ recipe: { recipeId: seed.recipe.recipeId, version: seed.recipe.version },
            name: currentDraft.name, selection: currentDraft.selection!, clientRequestId: creationRequestId });
          if (!isCurrent()) return;
          attempt.current.instantiated = instantiated; attempt.current.chatId = instantiated.chatId;
          attempt.current.definitionKey = key;
        }
      } else {
      if (!attempt.current.managed) {
        setPhase("saving");
        const managed = await client.bots.createCustom!({ ...fields, clientRequestId: creationRequestId,
          ...(seed.kind === "recipe" ? { seedRecipe: { recipeId: seed.recipe.recipeId, version: seed.recipe.version } } : {}) });
        if (!isCurrent()) return;
        attempt.current.managed = managed; attempt.current.chatId = managed.chatId;
      }
      const saved = await recoverCreatedCustomBot(client, attempt.current.managed, currentDraft, isCurrent);
      if (!isCurrent()) return;
      if (!saved) throw new Error("Readback unavailable");
      attempt.current.definitionKey = key;

      }
      const executor = currentDraft.taskExecutor?.model ? { connectionId: currentDraft.taskExecutor.connectionId, model: currentDraft.taskExecutor.model } : null;
      if (executor || attempt.current.executorAttempted) {
        setPhase("configuring"); attempt.current.executorAttempted = true;
        await configureCreatedExecutor(client.bots, attempt.current.chatId!, executor, isCurrent, true);
        if (!isCurrent()) return;
      }
      setPhase("opening");
      await onOpen(attempt.current.chatId!);
      if (isCurrent()) setPhase("ready");
    } catch (failure: unknown) {
      if (!isCurrent()) return;
      console.warn("[bot-creation] Setup failed:", failure instanceof Error ? failure.name : "UnknownError");
      setPhase("editing");
      setError(attempt.current.instantiated || attempt.current.managed || attempt.current.chatId
        ? "Your agent was saved. Setup could not finish. Retry to continue with this agent."
        : "Agent could not be created. Your draft is still here. Try again.");
    } finally {
      busy.current = false;
      if (isCurrent()) { setPending(false); onPendingChange?.(false); }
    }
  };
  return { ...value, sessionId, seedLoading, seedReady, seedEditable, pending, error, phase, disabled, retained: !!(attempt.current.instantiated || attempt.current.managed || attempt.current.chatId),
    isCurrent, applyDraftChange, create };
}
