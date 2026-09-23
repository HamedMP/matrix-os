import { isChatAgentDriver } from "@matrix-os/contracts";
import type { StartAgentChat } from "./client.js";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatAgentRecipeSchema, type ChatAgent, type ChatAgentRecipeCatalog, type CanonicalProviderCatalog, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { useChatAgentsNavigation } from "./ChatAgentsNavigation.js";
import { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { accountForNewIntegration } from "./recipe-integrations.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import { activeConnections } from "./recipe-integrations.js";
import { JEV_AGENT_DESCRIPTION, JEV_AGENT_INSTRUCTIONS, JEV_AGENT_NAME, jevAgentRecipe } from "./jev-agent-template.js";
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
  return <div className="matrix-chat-agents-library mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-7">
      <section className="matrix-chat-agents-hero overflow-hidden rounded-2xl border p-5 sm:p-6" aria-labelledby="agent-team-heading">
        <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em]" style={muted}>Agent library</p>
            <h3 id="agent-team-heading" className="mt-2 text-2xl font-semibold tracking-[-0.035em]">Your AI team</h3>
            <p className="mt-2 max-w-xl text-sm leading-6" style={muted}>Create specialists with their own role, skills, and connected tools—then bring them into any Chat with @.</p>
          </div>
          <div className="matrix-chat-agents-presence flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-xs">
            <span className="relative flex h-2.5 w-2.5" aria-hidden="true"><span className="absolute inline-flex h-full w-full rounded-full bg-emerald-500/25" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" /></span>
            <span>{state.agents.length ? `${state.agents.length} ready` : "Ready when you are"}</span>
          </div>
        </div>
      </section>
      <section aria-labelledby="agent-starters-heading" className="grid gap-3">
        <div className="flex items-end justify-between gap-3">
          <div><h3 id="agent-starters-heading" className="text-base font-semibold tracking-[-0.015em]">Build your team</h3>
            <p className="mt-1 text-xs" style={muted}>Start with a proven workflow or make a specialist from scratch.</p></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
        {state.recipeCatalog?.enabled ? <button type="button" aria-label="Personal Daily Brief" data-agent-template="daily-brief" className={`${button} matrix-chat-agent-card group min-h-32 min-w-0 overflow-hidden rounded-2xl p-4 text-left`} disabled={!state.catalog || state.agents.length >= 100}
          onClick={() => edit("daily-brief")}><span className="matrix-chat-agent-card__content flex h-full min-w-0 flex-col justify-between gap-5"><span className="flex items-start justify-between gap-3"><AgentAvatar id="template_daily_brief" name="Personal Daily Brief" /><span className="matrix-chat-agent-chip rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]">Starter</span></span><span className="min-w-0"><span className="block truncate text-base font-semibold" title="Personal Daily Brief">Personal Daily Brief</span><span className="mt-1 block text-xs leading-5" style={muted}>Turns email and calendar into a focused plan for your day.</span></span></span></button> : null}
        <button type="button" aria-label="New Agent" data-agent-template="custom" className={`${button} matrix-chat-agent-card group min-h-32 overflow-hidden rounded-2xl p-4 text-left`} disabled={!state.catalog || state.agents.length >= 100} onClick={() => edit("new")}>
          <span className="matrix-chat-agent-card__content flex h-full flex-col justify-between gap-5"><span className="grid h-12 w-12 place-items-center rounded-2xl border border-dashed text-2xl font-light" aria-hidden="true">+</span><span><span className="block text-base font-semibold">Create a specialist</span><span className="mt-1 block text-xs leading-5" style={muted}>Choose its role, instructions, model, and capabilities.</span></span></span>
        </button>
        </div>
      </section>
      {state.recipeLoading ? <p role="status" className="text-xs" style={muted}>Loading recipe templates…</p> : null}
      {state.recipeError || state.connectionError ? <div className="flex flex-wrap items-center gap-2"><p className="text-xs">{state.recipeError
        ? "Recipe templates are unavailable." : "Connection status is unavailable. Recipe account choices will ask when run."}</p>
        <button type="button" className={button} onClick={retryRecipes}>Retry recipe options</button></div> : null}
      <section aria-labelledby="agent-roster-heading" className="grid gap-3">
        <div><h3 id="agent-roster-heading" className="text-base font-semibold tracking-[-0.015em]">Your collaborators</h3>
          <p className="mt-1 text-xs" style={muted}>Specialists you can mention in any Chat.</p></div>
        {!state.agents.length && !state.error ? <div className="matrix-chat-agents-empty rounded-2xl border border-dashed px-5 py-8 text-center"><p className="text-sm font-medium">Your team is waiting to take shape.</p><p className="mx-auto mt-1 max-w-md text-xs leading-5" style={muted}>Create a reusable specialist for briefs, reviews, research, or any work you repeat.</p></div> : null}
        <div className="grid gap-3 sm:grid-cols-2">
        {state.agents.map((agent) => {
          const skills = agent.recipe?.skills.length ?? 0;
          const integrations = agent.recipe?.integrations.length ?? 0;
          const capabilitySummary = agent.recipe
            ? `${skills} ${skills === 1 ? "skill" : "skills"} · ${integrations} ${integrations === 1 ? "integration" : "integrations"}`
            : "Custom instructions";
          return <button key={agent.id} type="button" aria-label={`Edit ${agent.name}`} data-agent-card="saved" className={`${button} matrix-chat-agent-card group min-h-36 min-w-0 max-w-full overflow-hidden rounded-2xl p-4 text-left`} onClick={() => edit(agent)}>
            <span className="matrix-chat-agent-card__content flex h-full min-w-0 flex-col justify-between gap-5">
              <span className="flex min-w-0 items-start gap-3"><AgentAvatar id={agent.id} name={agent.name} /><span className="min-w-0 flex-1"><span className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate text-base font-semibold" title={agent.name}>{agent.name}</span><span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" title="Ready to mention" aria-hidden="true" /></span><span className="mt-1.5 block w-full min-w-0 text-xs leading-5" title={agent.description} style={muted}>{agent.description || "Saved specialist"}</span></span></span>
              <span className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]"><span className="matrix-chat-agent-mention max-w-full truncate rounded-full px-2 py-1 font-medium">@{agent.name}</span><span className="matrix-chat-agent-chip truncate rounded-full border px-2 py-1" style={muted}><span className="sr-only">Ready to mention · </span>{capabilitySummary}</span></span>
            </span>
          </button>;
        })}
        </div>
      </section>
    </div>;
}

export function ChatAgentsPanel({ client, view = "library", onClose, onSetup, onStartChat }: { client: ChatAgentClient; view?: "library" | "recipes"; onClose(): void; onSetup?: () => void; onStartChat?: StartAgentChat }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const jevCreateAttempt = useRef<{ accountLabel: string; selectionKey: string; requestId: string } | null>(null);
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
    isChatAgentDriver(choice.driverKind) && choice.interactionModes.includes("default") && choice.permissionModes.includes("full_access")) : [], [state.catalog]);
  const [jevPending, setJevPending] = useState(false);
  const [jevError, setJevError] = useState("");
  const jevUnavailable = state.loading || state.recipeLoading ? "Loading available accounts and Agent capabilities…"
    : !state.enabled ? "Agents are disabled for this computer."
    : state.connectionError || state.recipeError ? "Account or recipe options are unavailable. Try again later."
    : !models.some((choice) => choice.driverKind === "hermes") ? "Connect Hermes in Agents & providers first."
    : !state.recipeCatalog?.enabled || !["matrix-jev-email-triage", "matrix-integrations"].every((id) =>
      state.recipeCatalog?.skills.some((skill) => skill.id === id)) ? "Jev Agent skills are unavailable on this computer."
    : "";
  const createJev = async (accountLabel: string) => {
    if (jevPending || jevUnavailable || !onStartChat || state.agents.length >= 100) return;
    if (!activeConnections("gmail", state.connections).some((account) => account.account_label === accountLabel)) return;
    const hermes = models.find((choice) => choice.driverKind === "hermes");
    const recipe = jevAgentRecipe(accountLabel);
    if (!hermes || !ChatAgentRecipeSchema.safeParse(recipe).success
      || !recipeSkillsFit(recipe.skills, state.recipeCatalog?.skills ?? [])) return;
    const selectionKey = `${hermes.instanceId}:${hermes.modelId}`;
    if (jevCreateAttempt.current?.accountLabel !== accountLabel || jevCreateAttempt.current.selectionKey !== selectionKey) {
      jevCreateAttempt.current = { accountLabel, selectionKey, requestId: requestId() };
    }
    setJevPending(true);
    setJevError("");
    try {
      const saved = await client.create({ name: JEV_AGENT_NAME, description: JEV_AGENT_DESCRIPTION,
        instructions: JEV_AGENT_INSTRUCTIONS,
        selection: { instanceId: hermes.instanceId, model: hermes.modelId,
          ...(hermes.selectedOptions.length ? { options: hermes.selectedOptions } : {}) },
        recipe, clientRequestId: jevCreateAttempt.current.requestId,
      });
      const readback = await client.list();
      const verified = readback.agents.find((agent) => agent.id === saved.id);
      if (!verified || verified.recipe?.integrations.some((integration) =>
        integration.service === "gmail" && integration.accountLabel === accountLabel) !== true) {
        setJevError("Agent creation could not be verified in your library. Please check Agents before trying again.");
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
  const recipes = view === "recipes" && !state.editing;
  return <section aria-label={recipes ? "Agent recipes" : "Agents"} data-agent-surface={recipes ? "recipes" : "library"} className="matrix-chat-agents-panel ph-no-capture flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" style={chatAgentSurfaceStyle}>
    <header className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 sm:px-6">
      <h2 ref={heading} tabIndex={-1} className="sr-only outline-none">{recipes ? "Agent recipes" : state.editing === "new" ? "New Agent" : state.editing ? "Edit Agent" : "Agents"}</h2>
      <button type="button" className={`${button} shrink-0`} disabled={state.pending} onClick={onClose}>Back to Chat</button>
    </header>
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-8 sm:px-6">
    {recipes ? <AgentRecipesPanel onStartChat={onStartChat ? (text) => { onClose(); onStartChat(text); } : undefined}
      onCreateJev={onStartChat ? createJev : undefined} connections={state.connections}
      jevUnavailable={jevUnavailable} jevPending={jevPending} jevError={jevError} /> : <div className="mx-auto w-full max-w-3xl">
    <AgentLibraryBody state={state} models={models} edit={edit} change={change} save={save} archive={archive}
      back={() => patch({ editing: null, draft: null, error: "" })} retryRecipes={retryRecipes}
      setup={onSetup ? () => { onClose(); onSetup(); } : undefined} />
    {state.error ? <p role="alert" className="mt-4 text-sm">{state.error}</p> : state.notice ? <p role="status" className="mt-4 min-w-0 truncate text-sm" title={state.notice}>{state.notice}</p> : null}
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
