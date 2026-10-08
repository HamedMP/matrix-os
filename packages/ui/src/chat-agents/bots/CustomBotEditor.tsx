import { useId } from "react";
import type { ChatAgent, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { AgentModelField, type AgentDraft } from "../AgentEditor.js";
import { deriveCanonicalProviderChoices } from "../../canonical-provider-choice.js";
import { chatAgentInputClass, chatAgentButtonClass, chatAgentPrimaryButtonClass, chatAgentMutedStyle } from "../theme.js";

/** Editing identity text never rewrites the saved legacy recipe or dependencies. */
export function CustomBotEditor({ agent, draft, pending, catalog, catalogLoading, change, onSave, onCancel }: {
  agent: ChatAgent; draft: AgentDraft; pending: boolean; catalog?: CanonicalProviderCatalog | null; catalogLoading?: boolean;
  change(value: Partial<AgentDraft>): void; onSave(): Promise<void>; onCancel(): void;
}) {
  const id = useId();
  const selectionChanged = JSON.stringify(draft.selection) !== JSON.stringify(agent.selection);
  const models = catalog ? deriveCanonicalProviderChoices(catalog) : [];
  const selectionAvailable = models.some(model => model.instanceId === draft.selection?.instanceId && model.modelId === draft.selection?.model);
  const disabled = pending || !draft.name.trim() || !draft.instructions.trim() || (selectionChanged && (!selectionAvailable || catalogLoading));
  return <form className="mt-5 grid gap-4" onSubmit={event => { event.preventDefault(); if (!disabled) void onSave(); }}>
    <label className="grid gap-1.5 text-sm" htmlFor={`${id}-name`}>Name<input id={`${id}-name`} className={chatAgentInputClass} value={draft.name} maxLength={80} required disabled={pending} onChange={event => change({ name: event.target.value })}/></label>
    <label className="grid gap-1.5 text-sm" htmlFor={`${id}-description`}>Description<input id={`${id}-description`} className={chatAgentInputClass} value={draft.description} maxLength={400} disabled={pending} onChange={event => change({ description: event.target.value })}/></label>
    <label className="grid gap-1.5 text-sm" htmlFor={`${id}-instructions`}>Instructions<textarea id={`${id}-instructions`} className={`${chatAgentInputClass} min-h-32`} value={draft.instructions} maxLength={8000} required disabled={pending} onChange={event => change({ instructions: event.target.value })}/></label>
    <AgentModelField id={`${id}-model`} selected={draft.selection} pending={pending || Boolean(catalogLoading)} models={models} hermesOnly={Boolean(agent.recipe?.skills.includes("matrix-jev-email-triage"))} change={change}/>
    <p className="text-xs" style={chatAgentMutedStyle}>Saved workflow dependencies are preserved. Opening or editing this bot does not grant additional access.</p>
    <div className="flex gap-2"><button type="submit" className={chatAgentPrimaryButtonClass} disabled={disabled}>{pending ? "Saving…" : "Save changes"}</button><button type="button" className={chatAgentButtonClass} disabled={pending} onClick={onCancel}>Cancel</button></div>
  </form>;
}
