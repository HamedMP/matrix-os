import type {BotClient} from "./bots/client.js";
import { botModelChoiceMatchesSelection, isAutomaticBotSelection, matrixBotSelectableModelChoices, MatrixBotModelField } from "./bots/MatrixBotModelField.js";
import { useId, type ReactNode } from "react";
import { ChatAgentRecipeSchema, type ChatAgent, type ChatAgentRecipe, type ChatAgentRecipeCatalog, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { AgentRecipeEditor } from "./AgentRecipeEditor.js";
import { recipeSkillsFit } from "./recipe-skills.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
import { chatAgentButtonClass, chatAgentPrimaryButtonClass, chatAgentInputClass, chatAgentMutedStyle } from "./theme.js";
const button = chatAgentButtonClass;
const input = chatAgentInputClass;
const muted = chatAgentMutedStyle;
export type AgentDraft = { name: string; description: string; instructions: string; selection: CanonicalChatModelSelection | null; requestId: string; recipe?: ChatAgentRecipe | null };

function AgentModelField({ id, selected, pending, models, change, onSetup, hermesOnly }: {
  id: string; selected: CanonicalChatModelSelection | null; pending: boolean;
  models: ReturnType<typeof deriveCanonicalProviderChoices>;
  change(value: Partial<AgentDraft>): void; onSetup?: () => void;
  hermesOnly: boolean;
}) {
  const modelKey = selected ? JSON.stringify([selected.instanceId, selected.model]) : "";
  const available = models.some((choice) => choice.instanceId === selected?.instanceId && choice.modelId === selected?.model);
  return <>
    <label className="grid gap-1.5 text-sm" htmlFor={id}>Model<select id={id} className={input} value={modelKey} disabled={pending || models.length === 0} onChange={(event) => {
      const choice = models.find((candidate) => JSON.stringify([candidate.instanceId, candidate.modelId]) === event.target.value);
      if (choice) change({ selection: { instanceId: choice.instanceId, model: choice.modelId,
        ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) } });
    }}>
      {!available ? <option value={modelKey}>{selected ? `${selected.model} · unavailable` : "No Agent model available"}</option> : null}
      {models.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={JSON.stringify([choice.instanceId, choice.modelId])}>{choice.modelLabel} · {choice.connectionLabel ? `${choice.connectionLabel} · ` : ""}{choice.harnessLabel}</option>)}
    </select></label>
    {!available ? <p className="text-sm" style={muted}>{hermesOnly
      ? "Configure a supported Hermes model in Agents & providers to use this Inbox workflow."
      : "Choose a ready Matrix AI, Codex or Hermes model in Agents & providers to use this Agent."} {onSetup ? <button type="button" className="underline" disabled={pending} onClick={onSetup}>Open setup</button> : null}</p> : null}
  </>;
}

function AgentEditorActions({ editing, pending, saveDisabled, onArchive, onBack, allowArchive, cancelLabel }: {
  editing: ChatAgent | "new"; pending: boolean; saveDisabled: boolean;
  onArchive(): Promise<void>; onBack(): void; allowArchive: boolean; cancelLabel: string;
}) {
  return <div className="flex flex-wrap items-center gap-2">
    <button type="submit" className={chatAgentPrimaryButtonClass} disabled={saveDisabled}>{pending ? "Saving…" : editing === "new" ? "Create Agent" : "Save changes"}</button>
    <button type="button" className={button} disabled={pending} onClick={onBack}>{cancelLabel}</button>
    {editing !== "new" && allowArchive ? <button type="button" className={`${button} ml-auto`} disabled={pending} onClick={() => void onArchive()}>Archive Agent</button> : null}
  </div>;
}

export function AgentEditor({ botClient, draft, editing, pending, models, catalog, catalogLoading = false, recipeCatalog, connections, recipeLoading, recipeError, connectionError,
  change, onSave, onArchive, onBack, onSetup, onRetryRecipe, allowArchive = true, cancelLabel = "Back", apps }: {
  botClient?: BotClient; apps?: ReactNode; draft: AgentDraft; editing: ChatAgent | "new"; pending: boolean; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  recipeCatalog: ChatAgentRecipeCatalog | null; connections: ChatAgentIntegrationConnection[];
  recipeLoading: boolean; recipeError: string; connectionError: string;
  change(value: Partial<AgentDraft>): void; onSave(): Promise<void>; onArchive(): Promise<void>; onBack(): void;
  onRetryRecipe(): void; onSetup?: () => void; allowArchive?: boolean; cancelLabel?: string;
}) {
  const ids = useId();
  const recipeBot = editing !== "new" && Boolean(editing.recipeRef);
  const hermesOnly = draft.recipe?.skills.includes("matrix-jev-email-triage") === true;
  const managedAgent = recipeBot || !hermesOnly;
  const eligibleModels = managedAgent ? matrixBotSelectableModelChoices(models, catalog, recipeBot) : models;
  const selectionChanged = editing === "new" || JSON.stringify(draft.selection) !== JSON.stringify(editing.selection);
  const modelAvailable = eligibleModels.some((choice) => botModelChoiceMatchesSelection(choice, draft.selection));
  const recipeValid = recipeBot || draft.recipe === undefined || draft.recipe === null || (ChatAgentRecipeSchema.safeParse(draft.recipe).success
    && recipeSkillsFit(draft.recipe.skills, recipeCatalog?.skills ?? []));
  const saveDisabled = pending || (catalogLoading && selectionChanged) || !draft.name.trim() || !draft.instructions.trim() || !recipeValid
    || (selectionChanged && !modelAvailable && !(recipeBot && isAutomaticBotSelection(draft.selection)));
  return <form className="mt-5 grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!saveDisabled) void onSave(); }}>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-name`}>Name<input id={`${ids}-name`} className={input} value={draft.name} maxLength={80} required disabled={pending} onChange={(event) => change({ name: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-description`}>Description <span className="text-xs" style={muted}>Optional</span><input id={`${ids}-description`} className={input} value={draft.description} maxLength={400} disabled={pending} onChange={(event) => change({ description: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-instructions`}>Instructions<textarea id={`${ids}-instructions`} className={`${input} min-h-32 resize-y`} value={draft.instructions} maxLength={8000} required disabled={pending} placeholder="What should this Agent do? How should it work?" onChange={(event) => change({ instructions: event.target.value })} /></label>
      {apps}
      {managedAgent ? <div className="grid gap-3 text-sm">
        <MatrixBotModelField botClient={botClient} id={`${ids}-model`} selection={draft.selection} models={models} catalog={catalog} catalogLoading={catalogLoading} allowAutomatic={recipeBot} allowSubscription={recipeBot} preservedSelection={editing !== "new" && !recipeBot ? editing.selection : undefined} onSetup={onSetup} pending={pending} onChange={(selection) => change({ selection })} />
        <p className="text-xs" style={muted}>{recipeBot ? "This bot runs in its own Chat. Choose a Matrix AI model or keep Automatic computer routing." : "Choose a Matrix AI model for this agent. Saving an agent does not run it."}</p>
      </div> : <AgentModelField id={`${ids}-model`} selected={draft.selection} pending={pending} models={models} change={change} onSetup={onSetup} hermesOnly={draft.recipe?.skills.includes("matrix-jev-email-triage") === true} />}
      {!recipeBot ? <AgentRecipeEditor recipe={draft.recipe} hadRecipe={editing !== "new" && Boolean(editing.recipe)} catalog={recipeCatalog}
        connections={connections} loading={recipeLoading} error={recipeError} connectionError={connectionError} pending={pending}
        onChange={(recipe) => change({ recipe })} onRetry={onRetryRecipe} /> : null}
      {!recipeBot ? <p className="text-xs" style={muted}>Agent requests use Full access. You choose this access when sending. Creating an Agent does not run it.</p> : null}
      <AgentEditorActions editing={editing} pending={pending} saveDisabled={saveDisabled} onArchive={onArchive} onBack={onBack} allowArchive={allowArchive} cancelLabel={cancelLabel} />
    </form>;
}
