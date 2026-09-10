import { useId } from "react";
import type { ChatAgent, CanonicalChatModelSelection } from "@matrix-os/contracts";
import type { deriveCanonicalProviderChoices } from "../canonical-provider-choice.js";
const button = "rounded-lg border px-3 py-2 text-sm outline-none hover:enabled:bg-[var(--bg-hover,var(--matrix-secondary))] focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))] disabled:opacity-50";
const input = "w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))]";
const muted = { color: "var(--text-secondary, var(--matrix-muted-fg))" };
type Draft = { name: string; description: string; instructions: string; selection: CanonicalChatModelSelection | null; requestId: string };
export function AgentEditor({ draft, editing, pending, models, change, onSave, onArchive, onBack, onSetup }: {
  draft: Draft; editing: ChatAgent | "new"; pending: boolean; models: ReturnType<typeof deriveCanonicalProviderChoices>;
  change(value: Partial<Draft>): void; onSave(): Promise<void>; onArchive(): Promise<void>; onBack(): void; onSetup?: () => void;
}) {
  const ids = useId();
  const selectedModel = draft.selection;
  const modelKey = selectedModel ? JSON.stringify([selectedModel.instanceId, selectedModel.model]) : "";
  const modelAvailable = models.some((choice) => choice.instanceId === selectedModel?.instanceId && choice.modelId === selectedModel?.model);
  return <form className="mt-5 grid gap-4" onSubmit={(event) => { event.preventDefault(); void onSave(); }}>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-name`}>Name<input id={`${ids}-name`} className={input} value={draft.name} maxLength={80} required disabled={pending} onChange={(event) => change({ name: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-description`}>Description <span className="text-xs" style={muted}>Optional</span><input id={`${ids}-description`} className={input} value={draft.description} maxLength={400} disabled={pending} onChange={(event) => change({ description: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-instructions`}>Instructions<textarea id={`${ids}-instructions`} className={`${input} min-h-32 resize-y`} value={draft.instructions} maxLength={8000} required disabled={pending} placeholder="What should this Agent do? How should it work?" onChange={(event) => change({ instructions: event.target.value })} /></label>
      <label className="grid gap-1.5 text-sm" htmlFor={`${ids}-model`}>Model<select id={`${ids}-model`} className={input} value={modelKey} disabled={pending || models.length === 0} onChange={(event) => {
        const choice = models.find((candidate) => JSON.stringify([candidate.instanceId, candidate.modelId]) === event.target.value);
        if (choice) change({ selection: { instanceId: choice.instanceId, model: choice.modelId,
          ...(choice.selectedOptions.length ? { options: choice.selectedOptions } : {}) } });
      }}>
        {!modelAvailable ? <option value={modelKey}>{selectedModel ? `${selectedModel.model} · unavailable` : "No Hermes model available"}</option> : null}
        {models.map((choice) => <option key={`${choice.instanceId}:${choice.modelId}`} value={JSON.stringify([choice.instanceId, choice.modelId])}>{choice.modelLabel}</option>)}
      </select></label>
      {!modelAvailable ? <p className="text-sm" style={muted}>Set up Hermes in Agents &amp; providers to use this Agent. {onSetup ? <button type="button" className="underline" disabled={pending} onClick={onSetup}>Open setup</button> : null}</p> : null}
      <p className="text-xs" style={muted}>Hermes uses Full access for Agent requests. You choose this access when sending. Creating an Agent does not run it.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className={button} disabled={pending || !draft.name.trim() || !draft.instructions.trim() || (editing === "new" && !modelAvailable)}>{pending ? "Saving…" : editing === "new" ? "Create Agent" : "Save changes"}</button>
        <button type="button" className={button} disabled={pending} onClick={() => onBack()}>Back</button>
        {editing !== "new" ? <button type="button" className={`${button} ml-auto`} disabled={pending} onClick={() => void onArchive()}>Archive Agent</button> : null}
      </div>
    </form>;
}
