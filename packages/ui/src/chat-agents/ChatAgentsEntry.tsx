import { Dialog } from "../Dialog.js";
import { BotEditorApps } from "./bots/BotEditorApps.js";
import { matrixBotModelChoices } from "./bots/MatrixBotModelField.js";
import { isChatAgentDriver } from "@matrix-os/contracts";
import type { StartAgentChat } from "./client.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatAgentRecipeSchema, JevInboxTriageBindingSchema, type BotRecipeSummary, type ChatAgent, type ChatAgentRecipeCatalog, type CanonicalProviderCatalog, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";
import { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { accountForNewIntegration } from "./recipe-integrations.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import { activeConnections } from "./recipe-integrations.js";
import { JEV_AGENT_DESCRIPTION, JEV_AGENT_NAME, jevAgentInstructions, jevAgentRecipe, jevAgentSelection } from "./jev-agent-template.js";
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
  agents: ChatAgent[]; catalog: CanonicalProviderCatalog | null; enabled: boolean;
  loading: boolean; pending: boolean; error: string; notice: string;
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

function AgentLibraryBody({ state, client, models, edit, change, save, archive, back, retryRecipes, setup }: {
  state: Library; client: ChatAgentClient; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  edit(agent: ChatAgent | "new" | "daily-brief"): void; change(value: Partial<Draft>): void;
  save(): Promise<void>; archive(): Promise<void>; back(): void; retryRecipes(): void; setup?: () => void;
}) {
  if (state.loading) return <p role="status" className="mt-5 text-sm">Loading Agents…</p>;
  if (!state.enabled) return <p className="mt-5 text-sm">Agents are disabled for this computer.</p>;
  return <div className="matrix-chat-agents-library mx-auto grid w-full max-w-3xl gap-5 py-8">
    <div hidden={Boolean(state.editing)} inert={Boolean(state.editing)} className="grid gap-5">
    <header className="flex items-center justify-between gap-3">
      <h3 className="text-xl font-semibold">Your AI team</h3>
      <button type="button" aria-label="New Agent" className={button} disabled={!state.catalog || state.agents.length >= 100} onClick={() => edit("new")}>+ New agent</button>
    </header>
    {!state.agents.length && !state.error ? <p className="py-6 text-sm" style={muted}>No agents yet. Add an agent to get started.</p> : null}
    <div className="grid gap-2" aria-label="Saved agents">
      {state.agents.map(agent => <button key={agent.id} type="button" aria-label={`Edit ${agent.name}`} data-agent-card="saved"
        className={`${button} matrix-chat-agent-list-row flex min-w-0 items-center gap-3 p-3 text-left`} onClick={() => edit(agent)}>
        <AgentAvatar id={agent.id} name={agent.name} size="small" />
        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium" title={agent.name}>{agent.name}</span>
          <span className="mt-1 block truncate text-xs" title={agent.description} style={muted}>{agent.description || "Saved specialist"}</span></span>
        <span className="shrink-0 text-xs" style={muted}>{agent.recipeRef ? "Own Chat" : `@${agent.name}`}</span>
        <span aria-hidden="true" style={muted}>›</span>
      </button>)}
    </div>
    {state.recipeCatalog?.enabled ? <button type="button" aria-label="Personal Daily Brief" className={`${button} justify-self-start text-xs`}
      disabled={!state.catalog || state.agents.length >= 100} onClick={() => edit("daily-brief")}>Personal Daily Brief</button> : null}
    {state.recipeLoading ? <p role="status" className="text-xs" style={muted}>Loading recipe templates…</p> : null}
    {state.recipeError || state.connectionError ? <div className="flex flex-wrap items-center gap-2"><p className="text-xs">{state.recipeError
      ? "Recipe templates are unavailable." : "Connection status is unavailable. Recipe account choices will ask when run."}</p>
      <button type="button" className={button} onClick={retryRecipes}>Retry recipe options</button></div> : null}
    </div>
    {state.draft && state.editing ? <Dialog open aria-label={state.editing === "new" ? "New Agent" : "Edit Agent"}
      className="matrix-agent-edit-dialog" style={{...chatAgentSurfaceStyle, width:"min(92vw,440px)"}} onClose={() => { if (!state.pending) back(); }}>
      <header className="flex items-center gap-3"><AgentAvatar id={state.editing === "new" ? "new-agent" : state.editing.id} name={state.draft.name || "New agent"} size="small" />
        <div className="min-w-0 flex-1"><h3 className="text-base font-semibold">{state.editing === "new" ? "New agent" : "Edit agent"}</h3><p className="truncate text-xs" style={muted}>{state.draft.name}</p></div>
        <button type="button" className={button} aria-label="Close agent settings" disabled={state.pending} onClick={back}>×</button>
      </header>
      <AgentEditor draft={state.draft} editing={state.editing} pending={state.pending} models={models} catalog={state.catalog}
        recipeCatalog={state.recipeCatalog} connections={state.connections} recipeLoading={state.recipeLoading} recipeError={state.recipeError}
        connectionError={state.connectionError} change={change} onSave={save} onArchive={archive} onBack={back} onSetup={setup} onRetryRecipe={retryRecipes} cancelLabel="Cancel" apps={state.editing !== "new" && state.editing.recipeRef ? <BotEditorApps key={state.editing.id} agentId={state.editing.id} client={client}/> : undefined} />
      {state.error ? <p role="alert" className="mt-3 text-xs">{state.error}</p> : null}
    </Dialog> : null}
  </div>;
}

export function ChatAgentsPanel({ client, view = "library", onClose, onSetup, onStartChat, onOpenBotChat }: {
  client: ChatAgentClient; view?: "library" | "recipes"; onClose(): void; onSetup?: () => void;
  onStartChat?: StartAgentChat; onOpenBotChat?: (chatId: string) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const jevCreateAttempt = useRef<{ accountLabel: string; selectionKey: string; requestId: string } | null>(null);
  const [state, setState] = useState<Library>({ agents: [], catalog: null, enabled: true,
    loading: true, pending: false, error: "", notice: "", editing: null, draft: null,
    recipeCatalog: null, connections: [], recipeLoading: true, recipeError: "", connectionError: "" });
  const [botRecipes, setBotRecipes] = useState<BotRecipeSummary[]>([]);
  useEffect(() => {
    if (!client.bots) return;
    let current = true;
    void client.bots.recipes().then((recipes) => { if (current) setBotRecipes(recipes); }).catch((failure: unknown) => {
      console.warn("[chat-agents] Bot recipes unavailable:", failure instanceof Error ? failure.name : "UnknownError");
    });
    return () => { current = false; };
  }, [client]);
  useEffect(() => { heading.current?.focus(); }, [state.editing]);
  const patch = (value: Partial<Library>) => setState((current) => ({ ...current, ...value }));
  useEffect(() => {
    let current = true;
    void Promise.all([client.list(), client.catalog()]).then(([library, catalog]) => {
      if (current) setState((previous) => ({ ...previous, agents: library.agents, enabled: library.enabled, catalog, loading: false }));
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
  const models = useMemo(() => state.catalog ? deriveCanonicalProviderChoices(state.catalog).filter((choice) =>
    isChatAgentDriver(choice.driverKind) && choice.interactionModes.includes("default") && choice.permissionModes.includes("full_access")) : [], [state.catalog]);
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
    if (jevPending || jevUnavailable || !onStartChat) return;
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
      jevCreateAttempt.current = null;
      onClose();
      onStartChat("", [{ kind: "agent", id: verified.id, label: verified.name, revision: String(verified.revision) }]);
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
  const edit = (agent: ChatAgent | "new" | "daily-brief") => {
    const choice = models[0];
    const selection: CanonicalChatModelSelection | null = choice ? { instanceId: choice.instanceId, model: choice.modelId,
      ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) } : null;
    if (agent === "daily-brief") {
      patch({ editing: "new", notice: "", error: "", draft: {
        name: "Personal Daily Brief",
        description: "Prepare today's priorities from email and calendar.",
        instructions: "Prepare today's daily brief from connected email and calendar sources.",
        requestId: requestId(), selection,
        recipe: {
          skills: ["matrix-personal-daily-brief", "matrix-integrations"],
          integrations: ["gmail", "google_calendar"].map((service) => {
            const accountLabel = state.connectionError ? undefined : accountForNewIntegration(service, state.connections);
            return { service, ...(accountLabel ? { accountLabel } : {}) };
          }),
          output: "An English daily brief with today's schedule, actionable follow-ups, top priorities, source links or IDs, and data gaps.",
        },
      } });
      return;
    }
    patch({ editing: agent, notice: "", error: "", draft: agent === "new" ? {
      name: "", description: "", instructions: "", requestId: requestId(),
      selection,
    } : { name: agent.name, description: agent.description, instructions: agent.instructions, selection: agent.selection,
      requestId: requestId(), ...(agent.recipe ? { recipe: { skills: [...agent.recipe.skills],
        integrations: agent.recipe.integrations.map((integration) => ({ ...integration })), output: agent.recipe.output,
        ...(agent.recipe.jevInboxLabeling !== undefined ? { jevInboxLabeling: agent.recipe.jevInboxLabeling } : {}) } } : {}) } });
  };
  const change = (value: Partial<Draft>) => {
    const nextRequestId = requestId();
    setState((current) => ({ ...current, error: "",
      draft: current.draft ? { ...current.draft, ...value, requestId: nextRequestId } : null,
    }));
  };
  const save = async () => {
    const draft = state.draft;
    const recipeBot = state.editing !== null && state.editing !== "new" && Boolean(state.editing.recipeRef);
    if (state.pending || !draft?.selection || !draft.name.trim() || !draft.instructions.trim()
      || (!recipeBot && draft.recipe !== undefined && draft.recipe !== null && (!ChatAgentRecipeSchema.safeParse(draft.recipe).success
        || !recipeSkillsFit(draft.recipe.skills, state.recipeCatalog?.skills ?? [])))) return;
    patch({ pending: true, error: "" });
    try {
      const fields = { name: draft.name, description: draft.description, instructions: draft.instructions };
      const saved = state.editing === "new"
        ? await client.create({ ...fields, selection: draft.selection, clientRequestId: draft.requestId, ...(draft.recipe ? { recipe: draft.recipe } : {}) })
        : await client.update(state.editing!.id, { ...fields,
          ...(JSON.stringify(draft.selection) === JSON.stringify(state.editing!.selection) ? {} : { selection: draft.selection }), baseRevision: state.editing!.revision,
          ...(recipeBot || draft.recipe === undefined ? {} : { recipe: draft.recipe }) });
      setState((current) => ({ ...current, pending: false, editing: null, draft: null,
        agents: [...current.agents.filter((agent) => agent.id !== saved.id), saved],
        notice: recipeBot ? "Saved. Open this bot’s Chat from the sidebar to send a request."
          : `Saved. Type @${saved.name} in a Chat to give this Agent a request.`,
      }));
    } catch (failure: unknown) {
      console.warn("[chat-agents] Save failed:", failure instanceof Error ? failure.name : "UnknownError");
      patch({ pending: false, error: "Agent could not be saved. Your changes are still here. Try again or reopen the Agent to refresh." });
    }
  };
  const archive = async () => {
    if (state.pending || !state.editing || state.editing === "new") return;
    const agent = state.editing;
    patch({ pending: true, error: "" });
    try {
      await client.update(agent.id, { baseRevision: agent.revision, archived: true });
      setState((current) => ({ ...current, pending: false, editing: null, draft: null,
        agents: current.agents.filter((candidate) => candidate.id !== agent.id), notice: "Agent archived. Previous Chat replies are preserved.",
      }));
    } catch (failure: unknown) {
      console.warn("[chat-agents] Archive failed:", failure instanceof Error ? failure.name : "UnknownError");
      patch({ pending: false, error: "Agent could not be archived. Try again." });
    }
  };
  const recipes = view === "recipes" && !state.editing;
  return <section aria-label={recipes ? "Agent recipes" : "Agents"} data-agent-surface={recipes ? "recipes" : "library"} className="matrix-chat-agents-panel ph-no-capture flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={chatAgentSurfaceStyle}>
    <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 sm:px-6">
      <h2 ref={heading} tabIndex={-1} className="sr-only outline-none">{recipes ? "Agent recipes" : state.editing === "new" ? "New Agent" : state.editing ? "Edit Agent" : "Agents"}</h2>
      <button type="button" className={`${button} shrink-0`} disabled={state.pending} onClick={onClose}>Back to Chat</button>
    </header>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 sm:px-6">
    {recipes ? <AgentRecipesPanel onStartChat={onStartChat ? (text) => { onClose(); onStartChat(text); } : undefined}
      matrixModels={matrixBotModelChoices(models)} catalog={state.catalog} catalogLoading={state.loading} botRecipes={botRecipes} onOpenBotChat={onOpenBotChat ? async (chatId) => { await onOpenBotChat(chatId); onClose(); } : undefined}
      onInstantiateBot={client.bots && onOpenBotChat ? async (recipe, clientRequestId, selection, name) =>
        (await client.bots!.instantiate({ recipe, clientRequestId, ...(selection ? { selection } : {}), ...(name ? { name } : {}) })).chatId : undefined}
      onCreateJev={onStartChat ? createJev : undefined} connections={state.connections}
      jevUnavailable={jevUnavailable} jevPending={jevPending} jevError={jevError} /> : <div className="mx-auto w-full max-w-3xl">
    <AgentLibraryBody state={state} client={client} models={state.draft?.recipe?.skills.includes("matrix-jev-email-triage")
      ? models.filter(choice => choice.instanceId === jevSelection?.instanceId && choice.modelId === jevSelection?.model) : models}
      edit={edit} change={change} save={save} archive={archive}
      back={() => patch({ editing: null, draft: null, error: "" })} retryRecipes={retryRecipes}
      setup={onSetup ? () => { onClose(); onSetup(); } : undefined} />
    {state.error && !state.editing ? <p role="alert" className="mt-4 text-sm">{state.error}</p> : state.notice ? <p role="status" className="mt-4 min-w-0 truncate text-sm" title={state.notice}>{state.notice}</p> : null}
    </div>}
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
