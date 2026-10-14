import type { ChatAgent, ChatAgentRecipeCatalog, CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { Dialog } from "../Dialog.js";
import { BotEditorApps } from "./bots/BotEditorApps.js";
import { isLegacyDailyBriefEntry } from "./bots/daily-brief-navigation.js";
import { AgentEditor } from "./AgentEditor.js";
import { AgentAvatar } from "./AgentAvatar.js";
import type { ChatAgentClient, ChatAgentIntegrationConnection } from "./client.js";
import type { AgentDraft } from "./agent-draft.js";
import { chatAgentButtonClass as button, chatAgentMutedStyle as muted, chatAgentSurfaceStyle } from "./theme.js";
type Draft = AgentDraft;
export type Library = {
  agents: ChatAgent[]; catalog: CanonicalProviderCatalog | null; enabled: boolean;
  loading: boolean; catalogLoading?: boolean; pending: boolean; error: string; notice: string;
  recipeCatalog: ChatAgentRecipeCatalog | null; connections: ChatAgentIntegrationConnection[];
  recipeLoading: boolean; recipeError: string; connectionError: string;
  editing: ChatAgent | "new" | null; draft: Draft | null;
};

export function AgentLibraryBody({ state, client, models, edit, newAgent, chooser = false, change, save, archive, back, retryRecipes, setup, openDailyBrief, refreshModels, setupPaused }: {
  state: Library; client: ChatAgentClient; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  edit(agent: ChatAgent | "new"): void; openDailyBrief?: () => void; change(value: Partial<Draft>): void;
  newAgent(): void; chooser?: boolean;
  save(): Promise<void>; archive(): Promise<void>; back(): void; retryRecipes(): void; setup?: () => void; refreshModels(): void; setupPaused: boolean;
}) {
  if (state.loading) return <p role="status" className="mt-5 text-sm">Loading Agents…</p>;
  if (!state.enabled) return <p className="mt-5 text-sm">Agents are disabled for this computer.</p>;
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
      <AgentEditor botClient={client.bots} draft={state.draft} editing={state.editing} pending={state.pending} models={models} catalog={state.catalog} catalogLoading={state.catalogLoading}
        recipeCatalog={state.recipeCatalog} connections={state.connections} recipeLoading={state.recipeLoading} recipeError={state.recipeError}
        connectionError={state.connectionError} change={change} onSave={save} onArchive={archive} onBack={back} onSetup={setup} onRefreshCatalog={refreshModels} onRetryRecipe={retryRecipes} cancelLabel="Cancel" apps={state.editing !== "new" && state.editing.recipeRef ? <BotEditorApps key={state.editing.id} agentId={state.editing.id} client={client}/> : undefined} />
      {state.error ? <p role="alert" className="mt-3 text-xs">{state.error}</p> : null}
    </Dialog> : null}
  </div>;
}
