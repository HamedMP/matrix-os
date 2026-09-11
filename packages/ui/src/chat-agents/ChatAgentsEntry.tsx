import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatAgentRecipeSchema, type ChatAgent, type ChatAgentRecipeCatalog, type CanonicalProviderCatalog, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";
import { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { accountForNewIntegration } from "./recipe-integrations.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import { AgentEditor, type AgentDraft } from "./AgentEditor.js";
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

function AgentLibraryBody({ state, models, edit, change, save, archive, back, retryRecipes, setup }: {
  state: Library; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  edit(agent: ChatAgent | "new" | "daily-brief"): void; change(value: Partial<Draft>): void;
  save(): Promise<void>; archive(): Promise<void>; back(): void; retryRecipes(): void; setup?: () => void;
}) {
  if (state.loading) return <p role="status" className="mt-5 text-sm">Loading Agents…</p>;
  if (!state.enabled) return <p className="mt-5 text-sm">Agents are disabled for this computer.</p>;
  if (state.draft && state.editing) return <AgentEditor draft={state.draft} editing={state.editing} pending={state.pending} models={models}
    recipeCatalog={state.recipeCatalog} connections={state.connections} recipeLoading={state.recipeLoading} recipeError={state.recipeError}
    connectionError={state.connectionError}
    change={change} onSave={save} onArchive={archive} onBack={back} onSetup={setup} onRetryRecipe={retryRecipes} />;
  return <div className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" className={`${button} text-left`} disabled={!state.catalog || state.agents.length >= 100} onClick={() => edit("new")}>New Agent</button>
        {state.recipeCatalog?.enabled ? <button type="button" aria-label="Personal Daily Brief" className={`${button} min-w-0 text-left`} disabled={!state.catalog || state.agents.length >= 100}
          onClick={() => edit("daily-brief")}><span className="block truncate" title="Personal Daily Brief">Personal Daily Brief</span><span className="mt-1 block truncate text-xs" style={muted}>Email and calendar template</span></button> : null}
      </div>
      {state.recipeLoading ? <p role="status" className="text-xs" style={muted}>Loading recipe templates…</p> : null}
      {state.recipeError || state.connectionError ? <div className="flex flex-wrap items-center gap-2"><p className="text-xs">{state.recipeError
        ? "Recipe templates are unavailable." : "Connection status is unavailable. Recipe account choices will ask when run."}</p>
        <button type="button" className={button} onClick={retryRecipes}>Retry recipe options</button></div> : null}
      {!state.agents.length && !state.error ? <div className="rounded-xl border px-4 py-6 text-sm" style={muted}>No Agents yet. Create a reusable role for meeting briefs, reviews, or other work you repeat.</div> : null}
      {state.agents.map((agent) => <button key={agent.id} type="button" aria-label={`Edit ${agent.name}`} className={`${button} flex min-w-0 max-w-full flex-col gap-1 overflow-hidden text-left`} onClick={() => edit(agent)}>
        <span className="w-full min-w-0 truncate font-medium" title={agent.name}>{agent.name}</span>
        <span className="w-full min-w-0 truncate text-xs" title={agent.description} style={muted}>{agent.description || "Saved Hermes role"}</span>
      </button>)}
    </div>;
}

export function ChatAgentsPanel({ client, onClose, onSetup }: { client: ChatAgentClient; onClose(): void; onSetup?: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [state, setState] = useState<Library>({ agents: [], catalog: null, enabled: true,
    loading: true, pending: false, error: "", notice: "", editing: null, draft: null,
    recipeCatalog: null, connections: [], recipeLoading: true, recipeError: "", connectionError: "" });
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
    choice.driverKind === "hermes" && choice.interactionModes.includes("default") && choice.permissionModes.includes("full_access")) : [], [state.catalog]);
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
        integrations: agent.recipe.integrations.map((integration) => ({ ...integration })), output: agent.recipe.output } } : {}) } });
  };
  const change = (value: Partial<Draft>) => {
    const nextRequestId = requestId();
    setState((current) => ({ ...current, error: "",
      draft: current.draft ? { ...current.draft, ...value, requestId: nextRequestId } : null,
    }));
  };
  const save = async () => {
    const draft = state.draft;
    if (state.pending || !draft?.selection || !draft.name.trim() || !draft.instructions.trim()
      || (draft.recipe !== undefined && draft.recipe !== null && (!ChatAgentRecipeSchema.safeParse(draft.recipe).success
        || !recipeSkillsFit(draft.recipe.skills, state.recipeCatalog?.skills ?? [])))) return;
    patch({ pending: true, error: "" });
    try {
      const fields = { name: draft.name, description: draft.description, instructions: draft.instructions };
      const saved = state.editing === "new"
        ? await client.create({ ...fields, selection: draft.selection, clientRequestId: draft.requestId, ...(draft.recipe ? { recipe: draft.recipe } : {}) })
        : await client.update(state.editing!.id, { ...fields,
          ...(JSON.stringify(draft.selection) === JSON.stringify(state.editing!.selection) ? {} : { selection: draft.selection }), baseRevision: state.editing!.revision,
          ...(draft.recipe === undefined ? {} : { recipe: draft.recipe }) });
      setState((current) => ({ ...current, pending: false, editing: null, draft: null,
        agents: [...current.agents.filter((agent) => agent.id !== saved.id), saved],
        notice: `Saved. Type @${saved.name} in a Chat to give this Agent a request.`,
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
  return <section aria-label="Agents" className="ph-no-capture flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={chatAgentSurfaceStyle}>
    <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3 sm:px-6">
      <h2 ref={heading} tabIndex={-1} className="min-w-0 truncate text-lg font-semibold outline-none">{state.editing === "new" ? "New Agent" : state.editing ? "Edit Agent" : "Agents"}</h2>
      <button type="button" className={`${button} shrink-0`} disabled={state.pending} onClick={onClose}>Back to Chat</button>
    </header>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 sm:px-6">
    <div className="mx-auto w-full max-w-3xl">
    <p className="mt-2 text-sm" style={muted}>Save a role and call it with @ in any Chat. Each request runs through Hermes on this computer.</p>
    <AgentLibraryBody state={state} models={models} edit={edit} change={change} save={save} archive={archive}
      back={() => patch({ editing: null, draft: null, error: "" })} retryRecipes={retryRecipes}
      setup={onSetup ? () => { onClose(); onSetup(); } : undefined} />
    {state.error ? <p role="alert" className="mt-4 text-sm">{state.error}</p> : state.notice ? <p role="status" className="mt-4 min-w-0 truncate text-sm" title={state.notice}>{state.notice}</p> : null}
    </div>
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
