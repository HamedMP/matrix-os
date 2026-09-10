import { useId } from "react";
import { ChatAgentRecipeSchema, type ChatAgent, type ChatAgentRecipe, type ChatAgentRecipeCatalog, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { AgentRecipeEditor } from "./AgentRecipeEditor.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
const button = "rounded-lg border px-3 py-2 text-sm outline-none hover:enabled:bg-[var(--bg-hover,var(--matrix-secondary))] focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))] disabled:opacity-50";
const input = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))]";
const muted = { color: "var(--text-secondary, var(--matrix-muted-fg))" };
export type AgentDraft = { name: string; description: string; instructions: string; selection: CanonicalChatModelSelection | null; requestId: string; recipe?: ChatAgentRecipe | null };

function AgentModelField({ id, selected, pending, models, change, onSetup }: {
  id: string; selected: CanonicalChatModelSelection | null; pending: boolean;
  models: ReturnType<typeof deriveCanonicalProviderChoices>;
  change(value: Partial<AgentDraft>): void; onSetup?: () => void;
}) {
  const modelKey = selected ? JSON.stringify([selected.instanceId, selected.model]) : "";
  const available = models.some((choice) => choice.instanceId === selected?.instanceId && choice.modelId === selected?.model);
  return <>
    <label className="grid gap-1.5 text-sm" htmlFor={id}>Model<select id={id} className={input} value={modelKey} disabled={pending || models.length === 0} onChange={(event) => {
      const choice = models.find((candidate) => JSON.stringify([candidate.instanceId, candidate.modelId]) === event.target.value);
      if (choice) change({ selection: { instanceId: choice.instanceId, model: choice.modelId,
        ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) } });
    }}>
      {!available ? <option value={modelKey}>{selected ? `${selected.model} · unavailable` : "No Hermes model available"}</option> : null}
      {models.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={JSON.stringify([choice.instanceId, choice.modelId])}>{choice.modelLabel}</option>)}
    </select></label>
    {!available ? <p className="text-sm" style={muted}>Set up Hermes in Agents &amp; providers to use this Agent. {onSetup ? <button type="button" className="underline" disabled={pending} onClick={onSetup}>Open setup</button> : null}</p> : null}
  </>;
}

function AgentEditorActions({ editing, pending, saveDisabled, onArchive, onBack }: {
  editing: ChatAgent | "new"; pending: boolean; saveDisabled: boolean;
  onArchive(): Promise<void>; onBack(): void;
}) {
  return <div className="flex flex-wrap items-center gap-2">
    <button type="submit" className={button} disabled={saveDisabled}>{pending ? "Saving…" : editing === "new" ? "Create Agent" : "Save changes"}</button>
    <button type="button" className={button} disabled={pending} onClick={onBack}>Back</button>
    {editing !== "new" ? <button type="button" className={`${button} ml-auto`} disabled={pending} onClick={() => void onArchive()}>Archive Agent</button> : null}
  </div>;
}

export function AgentEditor({ draft, editing, pending, models, recipeCatalog, connections, recipeLoading, recipeError, connectionError,
  change, onSave, onArchive, onBack, onSetup, onRetryRecipe }: {
  draft: AgentDraft; editing: ChatAgent | "new"; pending: boolean; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  recipeCatalog: ChatAgentRecipeCatalog | null; connections: ChatAgentIntegrationConnection[];
  recipeLoading: boolean; recipeError: string; connectionError: string;
  change(value: Partial<AgentDraft>): void; onSave(): Promise<void>; onArchive(): Promise<void>; onBack(): void;
  onRetryRecipe(): void; onSetup?: () => void;
}) {
  const ids = useId();
  const modelAvailable = models.some((choice) => choice.instanceId === draft.selection?.instanceId && choice.modelId === draft.selection?.model);
  const recipeValid = draft.recipe === undefined || draft.recipe === null || ChatAgentRecipeSchema.safeParse(draft.recipe).success;
  const saveDisabled = pending || !draft.name.trim() || !draft.instructions.trim() || !recipeValid || (editing === "new" && !modelAvailable);
  return <form className="mt-5 grid gap-4" onSubmit={(event) => { event.preventDefault(); void onSave(); }}>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-name`}>Name<input id={`${ids}-name`} className={input} value={draft.name} maxLength={80} required disabled={pending} onChange={(event) => change({ name: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-description`}>Description <span className="text-xs" style={muted}>Optional</span><input id={`${ids}-description`} className={input} value={draft.description} maxLength={400} disabled={pending} onChange={(event) => change({ description: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-instructions`}>Instructions<textarea id={`${ids}-instructions`} className={`${input} min-h-32 resize-y`} value={draft.instructions} maxLength={8000} required disabled={pending} placeholder="What should this Agent do? How should it work?" onChange={(event) => change({ instructions: event.target.value })} /></label>
      <AgentModelField id={`${ids}-model`} selected={draft.selection} pending={pending} models={models} change={change} onSetup={onSetup} />
      <AgentRecipeEditor recipe={draft.recipe} hadRecipe={editing !== "new" && Boolean(editing.recipe)} catalog={recipeCatalog}
        connections={connections} loading={recipeLoading} error={recipeError} connectionError={connectionError} pending={pending}
        onChange={(recipe) => change({ recipe })} onRetry={onRetryRecipe} />
      <p className="text-xs" style={muted}>Hermes uses Full access for Agent requests. You choose this access when sending. Creating an Agent does not run it.</p>
      <AgentEditorActions editing={editing} pending={pending} saveDisabled={saveDisabled} onArchive={onArchive} onBack={onBack} />
    </form>;
}
