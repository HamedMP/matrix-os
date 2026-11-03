import type {BotClient} from "./bots/client.js";
import { MatrixBotModelField } from "./bots/MatrixBotModelField.js";
import { useId, type ReactNode } from "react";
import { isChatgptPlanBotRoute, type ChatAgent, type ChatAgentRecipe, type ChatAgentRecipeCatalog, type CanonicalChatModelSelection, type CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
import { AgentRecipeEditor } from "./AgentRecipeEditor.js";
import { agentEditorValidation, customAgentModelChoices } from "./agent-editor-validation.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
import { chatAgentButtonClass, chatAgentPrimaryButtonClass, chatAgentInputClass, chatAgentMutedStyle } from "./theme.js";
const button = chatAgentButtonClass;
const input = chatAgentInputClass;
const muted = chatAgentMutedStyle;
export type AgentDraft = { name: string; description: string; instructions: string; selection: CanonicalChatModelSelection | null; requestId: string; recipe?: ChatAgentRecipe | null };

export function AgentModelField({ id, selected, pending, models: suppliedModels, change, onSetup, hermesOnly }: {
  id: string; selected: CanonicalChatModelSelection | null; pending: boolean;
  models: ReturnType<typeof deriveCanonicalProviderChoices>;
  change(value: Partial<AgentDraft>): void; onSetup?: () => void;
  hermesOnly: boolean;
}) {
  const models = customAgentModelChoices(suppliedModels);
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
  change, onSave, onArchive, onBack, onSetup, onRefreshCatalog, onRetryRecipe, allowArchive = true, cancelLabel = "Back", apps, onRecover, recoveryDisabled, retainedSelection, retainedManaged, unfinishedRecovery = false }: {
  botClient?: BotClient; apps?: ReactNode; draft: AgentDraft; editing: ChatAgent | "new"; pending: boolean; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  recipeCatalog: ChatAgentRecipeCatalog | null; connections: ChatAgentIntegrationConnection[];
  recipeLoading: boolean; recipeError: string; connectionError: string;
  change(value: Partial<AgentDraft>): void; onSave(): Promise<void>; onArchive(): Promise<void>; onBack(): void;
  onRetryRecipe(): void; onSetup?: () => void; onRefreshCatalog?: () => void; allowArchive?: boolean; cancelLabel?: string;
  onRecover?: () => Promise<void>; recoveryDisabled?: boolean; unfinishedRecovery?: boolean;
  retainedSelection?: CanonicalChatModelSelection; retainedManaged?: boolean;
}) {
  const ids = useId();
  const validation = agentEditorValidation({ draft, editing, models, catalog, catalogLoading, recipeCatalog,
    managedCreation: Boolean(botClient?.createCustom), retainedSelection, retainedManaged });
  const { errors, recipeBot, managedCustom, editableRecipe, hermesOnly, managedAgent, subscriptionNew } = validation;
  const unsupportedRecipe = managedCustom && hermesOnly;
  const editableRecipeCatalog = managedCustom && recipeCatalog
    ? { ...recipeCatalog, skills: recipeCatalog.skills.filter(skill => skill.id !== "matrix-jev-email-triage") }
    : recipeCatalog;
  const saveDisabled = pending || unfinishedRecovery || !validation.valid;
  return <form className="mt-5 grid gap-4" onSubmit={(event) => { event.preventDefault(); if (!saveDisabled) void onSave(); }}>
      <p className="text-xs" style={muted}>Name, Instructions and Model are required. A recipe also requires Expected output.</p>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-name`}>Name<input id={`${ids}-name`} aria-invalid={Boolean(errors.name)} aria-describedby={errors.name ? `${ids}-name-error` : undefined} className={input} value={draft.name} maxLength={80} required disabled={pending} onChange={(event) => change({ name: event.target.value })} /></label>
      {errors.name ? <p id={`${ids}-name-error`} className="text-xs">{errors.name}</p> : null}
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-description`}>Description <span className="text-xs" style={muted}>Optional</span><input id={`${ids}-description`} className={input} value={draft.description} maxLength={400} disabled={pending} onChange={(event) => change({ description: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-instructions`}>Instructions<textarea id={`${ids}-instructions`} aria-invalid={Boolean(errors.instructions)} aria-describedby={errors.instructions ? `${ids}-instructions-error` : undefined} className={`${input} min-h-32 resize-y`} value={draft.instructions} maxLength={8000} required disabled={pending} placeholder="What should this Agent do? How should it work?" onChange={(event) => change({ instructions: event.target.value })} /></label>
      {errors.instructions ? <p id={`${ids}-instructions-error`} className="text-xs">{errors.instructions}</p> : null}
      {apps}
      {managedAgent ? <div className="grid gap-3 text-sm">
        <MatrixBotModelField botClient={botClient} id={`${ids}-model`} selection={draft.selection} models={models} catalog={catalog} catalogLoading={catalogLoading} allowAutomatic={recipeBot} allowSubscription={recipeBot || subscriptionNew} onRefreshCatalog={onRefreshCatalog} preservedSelection={editing !== "new" && !recipeBot ? editing.selection : undefined} onSetup={onSetup} pending={pending} onChange={(selection) => change({ selection })} />
        <p className="text-xs" style={muted}>{recipeBot ? "This bot runs in its own Chat. Choose a Matrix AI model or keep Automatic computer routing." : isChatgptPlanBotRoute({instanceId: draft.selection?.instanceId ?? "", driverKind: "matrix_bot"}) ? "This bot uses its selected subscription in its own Chat. Creating it does not run it." : "Choose a Matrix AI model for this agent. Saving an agent does not run it."}</p>
      </div> : <AgentModelField id={`${ids}-model`} selected={draft.selection} pending={pending} models={models} change={change} onSetup={onSetup} hermesOnly={draft.recipe?.skills.includes("matrix-jev-email-triage") === true} />}
      {unsupportedRecipe ? <p role="alert" className="text-sm">Remove the unavailable skill before saving this bot.</p> : null}
      {editableRecipe ? <AgentRecipeEditor recipe={draft.recipe} hadRecipe={editing !== "new" && Boolean(editing.recipe)} catalog={editableRecipeCatalog}
        connections={connections} loading={recipeLoading} error={recipeError} connectionError={connectionError} pending={pending}
        outputError={errors.output} onChange={(recipe) => change({ recipe })} onRetry={onRetryRecipe} /> : null}
      {!recipeBot && !subscriptionNew && draft.selection?.instanceId !== "matrix_chatgpt_plan" ? <p className="text-xs" style={muted}>Agent requests use Full access. You choose this access when sending. Creating an Agent does not run it.</p> : null}
      {!validation.valid && !pending ? <div role="status" className="grid gap-1 text-xs" aria-label="Requirements to save">
        {Object.entries(errors).filter(([, message]) => message !== "These skills are too large to use together. Remove a selected skill.")
          .map(([field, message]) => <p key={field}>{message}</p>)}
      </div> : null}
      {unfinishedRecovery ? <p role="status" className="text-xs">Finish recovery before saving changes to this Bot. Its existing Chat, history and permissions are preserved.</p> : null}
      <AgentEditorActions editing={editing} pending={pending} saveDisabled={saveDisabled} onArchive={onArchive} onBack={onBack} allowArchive={allowArchive} cancelLabel={cancelLabel} />
      {onRecover ? <div className="grid gap-2 text-xs">
        <p>{unfinishedRecovery ? "Recovery is unfinished. Continue to finish the same Bot and Chat." : "This older Bot needs recovery to use Matrix AI in its existing Chat. Its history and permissions are preserved."}</p>
        {recoveryDisabled && !pending ? <p>{unfinishedRecovery ? "Reopen this Bot to discard unsaved changes before recovering it." : "Save your changes or reopen this Bot before recovering it."}</p> : null}
        <button type="button" className={`${button} justify-self-start`} disabled={pending || recoveryDisabled} onClick={() => void onRecover()}>Recover Bot</button>
      </div> : null}
    </form>;
}
