import { saveAgentDraft, type AgentCreationAttempt } from "./save-agent-draft.js";
import { safeHttpStatus } from "./safe-http-status.js";
import { botCreationFailureMessage } from "./creation-error.js";
import { agentEditorValidation } from "./agent-editor-validation.js";
import { agentDraftMatchesSaved, recoverSavedFundedBot, savedAgentRecoveryBaseRevision } from "./saved-agent-recovery.js";
import { useAgentProviderCatalog, type AgentProviderCatalogSource } from "./use-agent-provider-catalog.js";
import {configureCreatedExecutor} from "./bots/configure-created-executor.js";
import type {BotExecutorSelection} from "./bots/BotTaskExecutorField.js";
import { Dialog } from "../Dialog.js";
import { BotEditorApps } from "./bots/BotEditorApps.js";
import { botModelChoiceMatchesSelection, isAutomaticBotSelection, matrixBotModelChoices, matrixBotSelectableModelChoices, matrixBotModelSelection } from "./bots/MatrixBotModelField.js";
import { isChatAgentDriver, MATRIX_CHATGPT_PLAN_INSTANCE_ID } from "@matrix-os/contracts";
import type { StartAgentChat } from "./client.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatAgentRecipeSchema, JevInboxTriageBindingSchema, type InstantiateBotResponse, type BotRecipeSummary, type ChatAgent, type ChatAgentListResponse, type ChatAgentRecipeCatalog, type CanonicalProviderCatalog, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";
import { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { DAILY_BRIEF_RECIPE_ID, isLegacyDailyBriefEntry } from "./bots/daily-brief-navigation.js";
import { BotRecipeSetup } from "./bots/BotRecipeSetup.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import { activeConnections } from "./recipe-integrations.js";
import { JEV_AGENT_DESCRIPTION, JEV_AGENT_NAME, jevAgentInstructions, jevAgentRecipe, jevAgentSelection } from "./jev-agent-template.js";
import { editableAgentRecipe } from "./recipe-edit.js";
import { AgentEditor, type AgentDraft } from "./AgentEditor.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { AgentRecipesPanel } from "./AgentRecipesPanel.js";
export { ChatAgentsRailSection } from "./ChatAgentsRailSection.js";
import type { ChatAgentClient, ChatAgentIntegrationConnection } from "./client.js";
import { chatAgentButtonClass, chatAgentLauncherClass, chatAgentMutedStyle, chatAgentSurfaceStyle } from "./theme.js";

const button = chatAgentButtonClass;
const muted = chatAgentMutedStyle;
const requestId = () => `req_${crypto.randomUUID().replaceAll("-", "")}`;
type Draft = AgentDraft;
type Library = {
  managedCustomRecoveries?: ChatAgentListResponse["managedCustomRecoveries"];
  agents: ChatAgent[]; catalog: CanonicalProviderCatalog | null; enabled: boolean;
  loading: boolean; catalogLoading?: boolean; pending: boolean; error: string; notice: string;
  recipeCatalog: ChatAgentRecipeCatalog | null; connections: ChatAgentIntegrationConnection[];
  recipeLoading: boolean; recipeError: string; connectionError: string;
  editing: ChatAgent | "new" | null; draft: Draft | null;
};

async function loadRecipeResources(client: ChatAgentClient) {
  const [catalogResult, connectionsResult] = await Promise.allSettled([client.recipeCatalog(), client.integrations()]);
  if (catalogResult.status === "rejected") console.warn("[chat-agents] Recipe catalog unavailable:",
    catalogResult.reason instanceof Error ? catalogResult.reason.name : "UnknownError");
  if (connectionsResult.status === "rejected") console.warn("[chat-agents] Connection status unavailable:",
    connectionsResult.reason instanceof Error ? connectionsResult.reason.name : "UnknownError");
  return {
    ...(catalogResult.status === "fulfilled" ? { recipeCatalog: catalogResult.value } : {}),
    ...(connectionsResult.status === "fulfilled" ? { connections: connectionsResult.value } : {}),
    recipeError: catalogResult.status === "rejected" ? "Recipe options are unavailable." : "",
    connectionError: connectionsResult.status === "rejected" ? "Connection status is unavailable." : "",
  };
}

function DailyBriefCreation({ onRefreshCatalog, onSetup, recipe, client, models, catalog, catalogLoading, onOpen, onClose }: {
  onRefreshCatalog?:()=>void; onSetup?:()=>void; recipe: BotRecipeSummary; client: ChatAgentClient; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  catalog: CanonicalProviderCatalog | null; catalogLoading: boolean; onOpen(chatId: string): void | Promise<void>; onClose(): void;
}) {
  const [selection, setSelection] = useState<CanonicalChatModelSelection | null>(() => {
    const choice = matrixBotSelectableModelChoices(models, catalog)[0];
    return choice ? matrixBotModelSelection(choice) : null;
  });
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const opening = useRef(false), generation = useRef(0);
  const attempt = useRef<{ key: string; requestId: string; chatId?:string; executorAttempted?:boolean } | null>(null);
  useEffect(() => {attempt.current=null; setPending(false); return () => { generation.current += 1; opening.current = false; };}, [client]);
  const available = Boolean(selection && (isAutomaticBotSelection(selection) || matrixBotSelectableModelChoices(models, catalog)
    .some(choice => botModelChoiceMatchesSelection(choice, selection))));
  const create = async (name: string, executor:BotExecutorSelection | null = null) => {
    if (!client.bots || opening.current || !selection || !available || catalogLoading) return;
    const fields = { recipe: { recipeId: recipe.recipeId, version: recipe.version }, name, selection };
    const key = JSON.stringify(fields);
    if (!attempt.current?.chatId && attempt.current?.key !== key) attempt.current = { key, requestId: requestId() };
    const currentGeneration = generation.current, current = () => generation.current === currentGeneration;
    opening.current = true; setPending(true); setError("");
    try {
      const chatId = attempt.current.chatId ?? (await client.bots.instantiate({ ...fields, clientRequestId: attempt.current.requestId })).chatId;
      if(!current()) return;
      attempt.current.chatId=chatId;
      if(executor || attempt.current.executorAttempted) {attempt.current.executorAttempted=true; await configureCreatedExecutor(client.bots,chatId,executor,current,true);}
      if (!current()) return;
      await onOpen(chatId);
      if (current()) onClose();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Daily Brief creation failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (current()) setError(attempt.current?.chatId ? "Your bot was created. Task setup could not complete. Retry to continue." : "Bot could not be created. Try again.");
    } finally {
      if (current()) { opening.current = false; setPending(false); }
    }
  };
  return <BotRecipeSetup onRefreshCatalog={onRefreshCatalog} onSetup={onSetup} botClient={client.bots} creationRetained={!!attempt.current?.chatId} recipe={recipe} selection={selection} models={models} catalog={catalog} catalogLoading={catalogLoading}
    pending={pending} createDisabled={!available || catalogLoading} error={error} onSelectionChange={value => { setSelection(value); setError(""); }}
    onCreate={(name,executor) => { void create(name,executor); }} onClose={onClose} />;
}

function AgentLibraryBody({ state, client, models, retainedCreation, recover, edit, newAgent, chooser = false, change, save, archive, back, retryRecipes, setup, openDailyBrief, refreshModels, setupPaused }: {
  retainedCreation?: AgentCreationAttempt | null; state: Library; client: ChatAgentClient; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  edit(agent: ChatAgent | "new"): void; openDailyBrief?: () => void; change(value: Partial<Draft>): void;
  newAgent(): void; chooser?: boolean;
  recover(): Promise<void>; save(): Promise<void>; archive(): Promise<void>; back(): void; retryRecipes(): void; setup?: () => void; refreshModels(): void; setupPaused: boolean;
}) {
  if (state.loading) return <p role="status" className="mt-5 text-sm">Loading Agents…</p>;
  if (!state.enabled) return <p className="mt-5 text-sm">Agents are disabled for this computer.</p>;
  const editingId = state.editing && state.editing !== "new" ? state.editing.id : undefined;
  const unfinishedRecovery = state.managedCustomRecoveries?.some(recovery => recovery.agentId === editingId) ?? false;
  return <div className="matrix-chat-agents-library mx-auto grid w-full max-w-3xl gap-5 py-8">
    <div hidden={chooser || Boolean(state.editing)} inert={chooser || Boolean(state.editing)} className="grid gap-5">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="sr-only">Saved agents</h3>
      {client.bots ? <button type="button" aria-label="Personal Daily Brief" className={button}
        disabled={state.pending || !openDailyBrief} onClick={openDailyBrief}>Personal Daily Brief</button> : null}
      <button type="button" aria-label="New Agent" className={`${button} ml-auto`} disabled={state.pending || !state.catalog || state.agents.length >= 100} onClick={newAgent}>+ New agent</button>
    </header>
    {!state.agents.length && !state.error ? <p className="py-6 text-sm" style={muted}>No agents yet. Add an agent to get started.</p> : null}
    <div className="grid gap-2" aria-label="Saved agents">
      {state.agents.map(agent => <button key={agent.id} type="button" aria-label={`Edit ${agent.name}`} data-agent-card="saved" disabled={state.pending}
        className={`${button} matrix-chat-agent-list-row flex min-w-0 items-center gap-3 p-3 text-left`} onClick={() => edit(agent)}>
        <AgentAvatar id={agent.id} name={agent.name} size="small" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium" title={agent.name}>{agent.name}</span>
          <span className="mt-1 block truncate text-xs" title={agent.description} style={muted}>{agent.description || "Saved specialist"}</span></span>
        <span className="shrink-0 text-xs" style={muted}>{agent.recipeRef || isLegacyDailyBriefEntry(agent) ? "Own Chat" : `@${agent.name}`}</span>
        <span aria-hidden="true" style={muted}>›</span>
      </button>)}
    </div>
    {state.recipeLoading ? <p role="status" className="text-xs" style={muted}>Loading recipe templates…</p> : null}
    {state.recipeError || state.connectionError ? <div className="flex flex-wrap items-center gap-2"><p className="text-xs">{state.recipeError
      ? "Recipe templates are unavailable." : "Connection status is unavailable. Recipe account choices will ask when run."}</p>
      <button type="button" className={button} onClick={retryRecipes}>Retry recipe options</button></div> : null}
    </div>
    {state.draft && state.editing ? <Dialog open={!setupPaused} aria-label={state.editing === "new" ? "New Agent" : "Edit Agent"}
      className="matrix-agent-edit-dialog" style={{...chatAgentSurfaceStyle, width:"min(92vw,460px)"}} onClose={() => { if (!state.pending) back(); }}>
      <header className="flex items-center gap-3"><AgentAvatar id={state.editing === "new" ? "new-agent" : state.editing.id} name={state.draft.name || "New agent"} size="small" />
        <div className="min-w-0 flex-1"><h3 className="text-base font-semibold">{state.editing === "new" ? "New agent" : "Edit agent"}</h3><p className="truncate text-xs" style={muted}>{state.draft.name}</p></div>
        <button type="button" className={button} aria-label="Close agent settings" disabled={state.pending} onClick={back}>×</button>
      </header>
      <AgentEditor unfinishedRecovery={unfinishedRecovery} botClient={client.bots} retainedManaged={retainedCreation?.managed} retainedSelection={retainedCreation?.input.selection} draft={state.draft} editing={state.editing} pending={state.pending} models={models} catalog={state.catalog} catalogLoading={state.catalogLoading}
        recipeCatalog={state.recipeCatalog} connections={state.connections} recipeLoading={state.recipeLoading} recipeError={state.recipeError}
        connectionError={state.connectionError} change={change} onSave={save} onArchive={archive} onBack={back} onSetup={setup} onRefreshCatalog={refreshModels} onRetryRecipe={retryRecipes} cancelLabel="Cancel" onRecover={state.editing !== "new" && savedAgentRecoveryBaseRevision(state.editing, state.managedCustomRecoveries) !== undefined && client.bots?.recoverManagedCustom ? recover : undefined}
        recoveryDisabled={state.editing !== "new" && !agentDraftMatchesSaved(state.draft, state.editing)} apps={state.editing !== "new" && state.editing.recipeRef ? <BotEditorApps key={state.editing.id} agentId={state.editing.id} client={client}/> : undefined} />
      {state.error ? <p role="alert" className="mt-3 text-xs">{state.error}</p> : null}
    </Dialog> : null}
  </div>;
}

type ChatAgentsPanelProps = {
  hostedChrome?: boolean; onTitleChange?: (title: "Your AI team" | "New agent" | "Edit agent") => void;
  headerLeading?: ReactNode;
  client: ChatAgentClient; view?: "library" | "recipes"; onClose(): void; onSetup?: () => void;
  onStartChat?: StartAgentChat; onOpenBotChat?: (chatId: string) => void;
  requestedRecipeId?: string;
  onRequestedRecipeResult?: (result: { ok: true } | { ok: false; error: "recipe_unavailable" | "navigation_unavailable" }) => void;
  providerCatalog?: AgentProviderCatalogSource;
};

export function ChatAgentsPanel(props: ChatAgentsPanelProps) {
  const navigation = useChatAgentsNavigation();
  const generation = navigation?.generation;
  const [scope, setScope] = useState({ client: props.client, view: props.view, generation, key: 0 });
  let current = scope;
  if (scope.client !== props.client || scope.view !== props.view || scope.generation !== generation) {
    current = { client: props.client, view: props.view, generation, key: scope.key + 1 };
    setScope(current);
  }
  // A new host navigation or owner must not inherit another creation draft.
  return <ChatAgentsPanelBody key={current.key} {...props}/>;
}

function ChatAgentsPanelBody({ client, view = "library", onClose, onSetup, onStartChat, onOpenBotChat, hostedChrome = false, onTitleChange,
  headerLeading, requestedRecipeId, onRequestedRecipeResult, providerCatalog }: ChatAgentsPanelProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const scratchTrigger = useRef<HTMLButtonElement | null>(null);
  const [creationView, setCreationView] = useState(view === "recipes");
  const [dailyRecipe, setDailyRecipe] = useState<{ client: ChatAgentClient; recipe: BotRecipeSummary } | null>(null);
  const creationAttempt = useRef<AgentCreationAttempt | null>(null);
  const [retainedCreation, setRetainedCreation] = useState<AgentCreationAttempt | null>(null);
  const recoveredBot = useRef<InstantiateBotResponse | null>(null);
  const saving = useRef(false);
  const mounted = useRef(false);
  const editorGeneration = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const jevCreateAttempt = useRef<{ accountLabel: string; selectionKey: string; requestId: string } | null>(null);
  const [library, setState] = useState<Library>({ agents: [], catalog: null, enabled: true,
    loading: true, pending: false, error: "", notice: "", editing: null, draft: null,
    recipeCatalog: null, connections: [], recipeLoading: true, recipeError: "", connectionError: "" });
  const modelCatalog = useAgentProviderCatalog(client, providerCatalog);
  const state = { ...library, catalog: modelCatalog.catalog, catalogLoading: modelCatalog.loading };
  const [setupPaused, setSetupPaused] = useState(false);
  const [botRecipeAttempt, setBotRecipeAttempt] = useState(0);
  const [botRecipeResult, setBotRecipeResult] = useState<{
    client: ChatAgentClient; attempt: number; status: "ready" | "unavailable"; recipes: BotRecipeSummary[];
  } | null>(null);
  const currentBotRecipes = botRecipeResult?.client === client && botRecipeResult.attempt === botRecipeAttempt
    ? botRecipeResult : null;
  const botRecipeStatus = client.bots ? currentBotRecipes?.status ?? "loading" : undefined;
  const botRecipes = currentBotRecipes?.status === "ready" ? currentBotRecipes.recipes : [];
  useEffect(() => {
    if (!client.bots) return;
    let current = true;
    void client.bots.recipes().then((recipes) => {
      if (current) setBotRecipeResult({ client, attempt: botRecipeAttempt, status: "ready", recipes });
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Bot recipes unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setBotRecipeResult({ client, attempt: botRecipeAttempt, status: "unavailable", recipes: [] });
    });
    return () => { current = false; };
  }, [client, botRecipeAttempt]);
  useEffect(() => {
    if (creationView && !state.editing && scratchTrigger.current?.isConnected && !scratchTrigger.current.disabled) scratchTrigger.current.focus();
    else heading.current?.focus();
  }, [state.editing, creationView]);
  const patch = (value: Partial<Library>) => setState((current) => ({ ...current, ...value }));
  useEffect(() => {
    let current = true;
    void client.list().then((library) => {
      if (current) setState((previous) => ({ ...previous, agents: library.agents, managedCustomRecoveries: library.managedCustomRecoveries, enabled: library.enabled, loading: false }));
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Library unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setState((previous) => ({ ...previous, loading: false, error: "Agents could not be loaded. Close and try again." }));
    });
    return () => { current = false; };
  }, [client]);
  useEffect(() => {
    let current = true;
    void loadRecipeResources(client).then((resources) => {
      if (current) setState((previous) => ({ ...previous, ...resources, recipeLoading: false }));
    });
    return () => { current = false; };
  }, [client]);
  const openDailyBrief = () => {
    modelCatalog.refresh();
    const recipe = botRecipes.find(candidate => candidate.recipeId === DAILY_BRIEF_RECIPE_ID);
    if (!recipe) { patch({ error: "Daily Brief setup is unavailable. Close Agents and try again." }); return; }
    patch({ error: "" });
    setDailyRecipe({ client, recipe: { ...recipe, name: "Personal Daily Brief" } });
  };
  const providerModels = useMemo(() => state.catalog ? deriveCanonicalProviderChoices(state.catalog) : [], [state.catalog]);
  // Ordinary Agents request Full access; recipe Bots use the coordinator's own
  // permission contract and must retain account/grant-bound subscription choices.
  const models = useMemo(() => providerModels.filter((choice) => isChatAgentDriver(choice.driverKind) && choice.instanceId !== MATRIX_CHATGPT_PLAN_INSTANCE_ID
    && choice.interactionModes.includes("default") && choice.permissionModes.includes("full_access")), [providerModels]);
  const botModels = useMemo(() => matrixBotModelChoices(providerModels), [providerModels]);
  const [jevPending, setJevPending] = useState(false);
  const [jevError, setJevError] = useState("");
  const jevSelection = jevAgentSelection(state.catalog ?? undefined);
  const jevUnavailable = state.loading || state.recipeLoading ? "Loading available accounts and Agent capabilities…"
    : !state.enabled ? "Agents are disabled for this computer."
    : state.connectionError || state.recipeError ? "Account or recipe options are unavailable. Try again later."
    : state.agents.length >= 100 ? "The 100-Agent limit has been reached. Archive an Agent before using this recipe."
    : !jevSelection ? "Choose a ready default Hermes route in Agents & providers first."
    : !state.recipeCatalog?.enabled || !["matrix-jev-email-triage", "matrix-integrations"].every((id) =>
      state.recipeCatalog?.skills.some((skill) => skill.id === id)) ? "Jev Agent skills are unavailable on this computer."
    : "";
  const createJev = async (accountLabel: string, labeling = false) => {
    if (jevPending || jevUnavailable || !onOpenBotChat || !client.bots) return;
    const matchingAccounts = activeConnections("gmail", state.connections).filter((account) => account.account_label === accountLabel);
    if (matchingAccounts.length !== 1 || !matchingAccounts[0]?.account_email) {
      setJevError("Choose a connected Gmail account with a recorded email address before creating this Agent.");
      return;
    }
    const hermes = jevSelection ? models.find((choice) => choice.instanceId === jevSelection.instanceId && choice.modelId === jevSelection.model) : undefined;
    const recipe = jevAgentRecipe(accountLabel, labeling);
    if (!hermes || !ChatAgentRecipeSchema.safeParse(recipe).success
      || !recipeSkillsFit(recipe.skills, state.recipeCatalog?.skills ?? [])) return;
    const selectionKey = `${hermes.instanceId}:${hermes.modelId}:${labeling}`;
    if (jevCreateAttempt.current?.accountLabel !== accountLabel || jevCreateAttempt.current.selectionKey !== selectionKey) {
      jevCreateAttempt.current = { accountLabel, selectionKey, requestId: requestId() };
    }
    setJevPending(true);
    setJevError("");
    try {
      const saved = await client.create({ name: JEV_AGENT_NAME, description: JEV_AGENT_DESCRIPTION,
        instructions: jevAgentInstructions(matchingAccounts[0].account_email),
        selection: { instanceId: hermes.instanceId, model: hermes.modelId,
          ...(hermes.selectedOptions.length ? { options: hermes.selectedOptions } : {}) },
        recipe, clientRequestId: jevCreateAttempt.current.requestId,
      });
      const readback = await client.list();
      const verified = readback.agents.find((agent) => agent.id === saved.id);
      const savedBinding = JevInboxTriageBindingSchema.safeParse(saved.recipe?.jevInboxTriage);
      const binding = JevInboxTriageBindingSchema.safeParse(verified?.recipe?.jevInboxTriage);
      if (!verified || verified.recipe?.integrations.some((integration) =>
        integration.service === "gmail" && integration.accountLabel === accountLabel) !== true
        || verified.revision !== saved.revision || !savedBinding.success || !binding.success
        || savedBinding.data.accountLabel !== accountLabel || binding.data.accountLabel !== accountLabel
        || binding.data.ownerId !== savedBinding.data.ownerId
        || binding.data.connectionId !== savedBinding.data.connectionId
        || binding.data.expectedEmail !== savedBinding.data.expectedEmail) {
        setJevError("Agent creation could not be verified in your library. Please check Agents before trying again.");
        return;
      }
      if ((binding.data.labelingEnabled === true) !== labeling || (savedBinding.data.labelingEnabled === true) !== labeling
        || (verified.recipe?.jevInboxLabeling === true) !== labeling) {
        setJevError("Agent labeling permission could not be verified. Check Agents before trying again.");
        return;
      }
      const chatId = await client.bots.ensureDirectChat(verified.id);
      if (!chatId) throw new Error("Bot conversation unavailable");
      await onOpenBotChat(chatId);
      jevCreateAttempt.current = null;
      onClose();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Jev Agent creation failed:", failure instanceof Error ? failure.name : "UnknownError");
      setJevError("Agent could not be created. Please check Agents before trying again.");
    } finally {
      setJevPending(false);
    }
  };
  const retryRecipes = () => {
    if (state.recipeLoading) return;
    patch({ recipeLoading: true, recipeError: "", connectionError: "" });
    void loadRecipeResources(client).then((resources) => patch({ ...resources, recipeLoading: false }))
      .catch((failure: unknown) => {
        console.warn("[chat-agents] Recipe retry failed:", failure instanceof Error ? failure.name : "UnknownError");
        patch({ recipeLoading: false, recipeError: "Recipe options are unavailable." });
      });
  };
  const edit = (agent: ChatAgent | "new") => {
    creationAttempt.current = null;
    setRetainedCreation(null);
    recoveredBot.current = null;
    editorGeneration.current += 1;
    modelCatalog.refresh();
    const recipeBot = agent !== "new" && !!agent.recipeRef;
    const managedNew = agent === "new" && Boolean(client.bots?.createCustom);
    const choices = matrixBotSelectableModelChoices(recipeBot || managedNew ? botModels : models, state.catalog, recipeBot || managedNew);
    // A connected subscription remains an explicit source choice for a new custom Bot.
    const choice = managedNew ? choices.find(candidate => candidate.instanceId === "matrix_pi_default") : choices[0];
    const selection: CanonicalChatModelSelection | null = choice ? matrixBotModelSelection(choice) : null;
    patch({ editing: agent, notice: "", error: "", draft: agent === "new" ? {
      name: "", description: "", instructions: "", requestId: requestId(),
      selection,
    } : { name: agent.name, description: agent.description, instructions: agent.instructions, selection: agent.selection,
      requestId: requestId(), ...(agent.recipe ? { recipe: editableAgentRecipe(agent) } : {}) } });
  };
  const change = (value: Partial<Draft>) => {
    const nextRequestId = requestId();
    setState((current) => ({ ...current, error: "",
      draft: current.draft ? { ...current.draft, ...value, requestId: nextRequestId } : null,
    }));
  };
  const editorModels = !retainedCreation?.managed && state.draft?.recipe?.skills.includes("matrix-jev-email-triage")
    ? models.filter(choice => choice.instanceId === jevSelection?.instanceId && choice.modelId === jevSelection?.model)
    : retainedCreation?.managed === false ? models
    : state.editing === "new" && client.bots?.createCustom
      ? botModels.filter(choice => choice.instanceId === "matrix_pi_default" || choice.instanceId === MATRIX_CHATGPT_PLAN_INSTANCE_ID)
      : state.editing && state.editing !== "new" && state.editing.recipeRef ? botModels : models;
  const save = async () => {
    const draft = state.draft, editing = state.editing;
    if (saving.current || state.pending || !draft || !editing
      || editing !== "new" && state.managedCustomRecoveries?.some(recovery => recovery.agentId === editing.id)
      || !agentEditorValidation({ draft, editing, models: editorModels,
      catalog: state.catalog, catalogLoading: state.catalogLoading, recipeCatalog: state.recipeCatalog,
      managedCreation: Boolean(client.bots?.createCustom), retainedManaged: creationAttempt.current?.managed,
      retainedSelection: creationAttempt.current?.input.selection }).valid) return;
    const generation = editorGeneration.current;
    const current = () => mounted.current && generation === editorGeneration.current;
    saving.current = true;
    patch({ pending: true, error: "" });
    try {
      const { saved, managed, attempt } = await saveAgentDraft(client, creationAttempt, draft, editing, current);
      if (!current()) return;
      if (editing === "new" && onOpenBotChat && client.bots) {
        const chatId = attempt?.chatId ?? await client.bots.ensureDirectChat(saved.id);
        if (!chatId) throw new Error("Bot conversation unavailable");
        if (attempt) attempt.chatId = chatId;
        if (!current()) return;
        await onOpenBotChat(chatId);
        if (!current()) return;
        onClose();
      }
      creationAttempt.current = null;
      setRetainedCreation(null);
      setCreationView(false);
      setState((previous) => ({ ...previous, pending: false, editing: null, draft: null,
        agents: [...previous.agents.filter((agent) => agent.id !== saved.id), saved],
        notice: managed ? "Saved. Open this bot’s Chat from the sidebar to send a request."
          : `Saved. Type @${saved.name} in a Chat to give this Agent a request.`,
      }));
    } catch (failure: unknown) {
      console.warn("[chat-agents] Save failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (!current()) return;
      const attempt = creationAttempt.current?.client === client ? creationAttempt.current : null;
      setRetainedCreation(attempt ? { ...attempt } : null);
      patch({ pending: false, error: botCreationFailureMessage(failure) ?? (attempt?.result || attempt?.agent
        ? "Bot was created, but setup could not finish. Your changes are still here. Try again to finish this Bot."
        : attempt ? "We could not confirm whether your Bot was saved. Your changes are still here. Try again to safely finish the same Bot."
        : "Agent could not be saved. Your changes are still here. Try again or reopen the Agent to refresh.") });
    } finally {
      saving.current = false;
    }
  };
  const recover = async () => {
    const draft = state.draft, agent = state.editing;
    const baseRevision = agent && agent !== "new" ? savedAgentRecoveryBaseRevision(agent, state.managedCustomRecoveries) : undefined;
    if (saving.current || state.pending || !draft || !agent || agent === "new" || baseRevision === undefined
      || agent.selection.instanceId !== "matrix_pi_default" || !agentDraftMatchesSaved(draft, agent)) return;
    const generation = editorGeneration.current, current = () => mounted.current && generation === editorGeneration.current;
    saving.current = true;
    patch({ pending: true, error: "" });
    try {
      const { saved, chatId } = await recoverSavedFundedBot(client, recoveredBot, agent, draft, current, baseRevision);
      if (!current()) return;
      if (onOpenBotChat) await onOpenBotChat(chatId);
      if (!current()) return;
      recoveredBot.current = null;
      patch({ pending: false, editing: null, draft: null,
        managedCustomRecoveries: state.managedCustomRecoveries?.filter(recovery => recovery.agentId !== saved.id),
        agents: [...state.agents.filter(candidate => candidate.id !== saved.id), saved], notice: "Bot recovered. Its existing Chat is ready." });
      if (onOpenBotChat) onClose();
    } catch (failure: unknown) {
      console.warn("[chat-agents] Bot recovery failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (current()) patch({ pending: false, error: recoveredBot.current
        ? "Bot was recovered, but its Chat could not open. Try again to open the same Chat."
        : safeHttpStatus(failure) === 409
          ? "Bot changed since you opened it. Reopen it before recovering. Your changes are still here."
          : "Bot could not be recovered. Your changes are still here. Try again." });
    } finally { saving.current = false; }
  };
  const archive = async () => {
    if (saving.current || state.pending || !state.editing || state.editing === "new") return;
    const agent = state.editing;
    saving.current = true;
    patch({ pending: true, error: "" });
    try {
      await client.update(agent.id, { baseRevision: agent.revision, archived: true });
      setState((current) => ({ ...current, pending: false, editing: null, draft: null,
        agents: current.agents.filter((candidate) => candidate.id !== agent.id), notice: "Agent archived. Previous Chat replies are preserved.",
      }));
    } catch (failure: unknown) {
      console.warn("[chat-agents] Archive failed:", failure instanceof Error ? failure.name : "UnknownError");
      patch({ pending: false, error: "Agent could not be archived. Try again." });
    } finally { saving.current = false; }
  };
  const recipes = creationView;
  const scratchBlocked = state.loading || !state.enabled || state.pending || jevPending || state.agents.length >= 100;
  const title = state.editing === "new" || recipes ? "New agent" : state.editing ? "Edit agent" : "Your AI team";
  useEffect(() => { onTitleChange?.(title); }, [onTitleChange, title]);
  return <section aria-label={recipes ? "Agent recipes" : "Agents"} data-agent-surface={recipes ? "recipes" : "library"} className="matrix-chat-agents-panel ph-no-capture flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={chatAgentSurfaceStyle}>
    <header className={hostedChrome ? "sr-only" : "flex h-12 shrink-0 items-center justify-between gap-3 px-4 sm:px-6"} style={{ borderColor: "var(--border-default,var(--border))" }}>
      <div className="flex min-w-0 items-center gap-2">
        {headerLeading}
        <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold outline-none">{title}</h2>
      </div>
      {!hostedChrome ? <button type="button" aria-label="Close Agents" className={`${button} shrink-0`} disabled={state.pending} onClick={onClose}>×</button> : null}
    </header>
    {dailyRecipe?.client === client && client.bots && onOpenBotChat ? <DailyBriefCreation onRefreshCatalog={modelCatalog.refresh} onSetup={onSetup} recipe={dailyRecipe.recipe} client={client} models={botModels} catalog={state.catalog} catalogLoading={state.catalogLoading}
      onOpen={async chatId => { await onOpenBotChat(chatId); onClose(); }} onClose={() => setDailyRecipe(null)} /> : null}
    {setupPaused ? <button type="button" className={button} onClick={() => { setSetupPaused(false); modelCatalog.refresh(); }}>Resume agent setup</button> : null}
    {(!recipes || state.editing) && (modelCatalog.loading || modelCatalog.error) ? <div className="px-4 sm:px-6">
      <div className="matrix-chat-agent-catalog-status matrix-chat-agent-catalog-status--library">
        {modelCatalog.loading ? <p role="status">Loading models…</p> : <>
          <p role="alert">{modelCatalog.error}</p>
          <button type="button" className="matrix-chat-agent-catalog-retry" disabled={state.pending} onClick={modelCatalog.refresh}>Retry models</button>
        </>}
      </div>
    </div> : null}
    <div hidden={setupPaused} className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 sm:px-6">
    {recipes ? <div hidden={Boolean(state.editing)} inert={Boolean(state.editing)}><AgentRecipesPanel
      requestedRecipeId={requestedRecipeId} onRequestedRecipeResult={onRequestedRecipeResult}
      onStartFromScratch={trigger => { scratchTrigger.current = trigger; edit("new"); }}
      scratchDisabled={scratchBlocked || !state.catalog} scratchRetryDisabled={scratchBlocked} catalogError={modelCatalog.error}
      onRefreshCatalog={modelCatalog.refresh} onSetup={onSetup} botClient={client.bots} onStartChat={onStartChat ? (text) => { onClose(); onStartChat(text); } : undefined}
      botRecipeStatus={botRecipeStatus} onRetryBotRecipes={() => setBotRecipeAttempt(attempt => attempt + 1)}
      matrixModels={botModels} catalog={state.catalog} catalogLoading={state.catalogLoading} botRecipes={botRecipes} onOpenBotChat={onOpenBotChat ? async (chatId) => { await onOpenBotChat(chatId); onClose(); } : undefined}
      onInstantiateBot={client.bots && onOpenBotChat ? async (recipe, clientRequestId, selection, name) =>
        (await client.bots!.instantiate({ recipe, clientRequestId, ...(selection ? { selection } : {}), ...(name ? { name } : {}) })).chatId : undefined}
      onCreateJev={client.bots && onOpenBotChat ? createJev : undefined} connections={state.connections}
      jevUnavailable={jevUnavailable} jevPending={jevPending} jevError={jevError} /></div> : null}
    {!recipes || state.editing ? <div className="mx-auto w-full max-w-3xl">
    <AgentLibraryBody state={state} client={client} models={editorModels} retainedCreation={retainedCreation}
      openDailyBrief={client.bots && onOpenBotChat ? openDailyBrief : undefined}
      chooser={recipes} newAgent={() => setCreationView(true)} recover={recover} edit={edit} change={change} save={save} archive={archive}
      back={() => { editorGeneration.current += 1; patch({ editing: null, draft: null, error: "" }); }} retryRecipes={retryRecipes} refreshModels={modelCatalog.refresh} setupPaused={setupPaused}
      setup={onSetup ? () => { setSetupPaused(true); onSetup(); } : undefined} />
    {state.error && !state.editing ? <p role="alert" className="mt-4 text-sm">{state.error}</p> : state.notice ? <p role="status" className="mt-4 min-w-0 truncate text-sm" title={state.notice}>{state.notice}</p> : null}
    </div> : null}
    </div>
  </section>;
}

export function ChatAgentsEntry({ client, onSetup, onOpen, icon, className = "" }: {
  client?: ChatAgentClient; onSetup?: () => void; onOpen?: () => void; icon?: ReactNode; className?: string;
}) {
  const [availability, setAvailability] = useState<{ client: ChatAgentClient; enabled: boolean } | null>(null);
  const navigation = useChatAgentsNavigation();
  useEffect(() => {
    if (!client) return;
    let current = true;
    const refresh = () => { void client.list().then((result) => {
      if (current) setAvailability({ client, enabled: result.enabled });
    }).catch((failure: unknown) => {
      console.warn("[chat-agents] Feature state unavailable:", failure instanceof Error ? failure.name : "UnknownError");
      if (current) setAvailability({ client, enabled: false });
    }); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { current = false; window.removeEventListener("focus", refresh); };
  }, [client]);
  if (!navigation || !client || availability?.client !== client || !availability.enabled) return null;
  return <button type="button" aria-pressed={navigation.opened?.client === client} className={`${chatAgentLauncherClass} aria-pressed:bg-[var(--bg-hover,var(--matrix-secondary,var(--secondary)))] ${className}`} style={chatAgentMutedStyle}
    onClick={(event) => { navigation.open({ client, onSetup }, event.currentTarget); onOpen?.(); }}>{icon}Agents</button>;
}
