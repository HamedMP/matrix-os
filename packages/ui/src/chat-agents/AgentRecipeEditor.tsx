import { useId } from "react";
import type { ChatAgentRecipe, ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import { AgentRecipeIntegrations } from "./AgentRecipeIntegrations.js";
import type { ChatAgentIntegrationConnection } from "./client.js";
import { chatAgentButtonClass, chatAgentInputClass, chatAgentMutedStyle } from "./theme.js";

const button = chatAgentButtonClass;
const input = chatAgentInputClass;
const muted = chatAgentMutedStyle;

function EmptyRecipe({ ids, removing, catalog, pending, loading, error, connectionError, onChange, onRetry }: {
  ids: string; removing: boolean; catalog: ChatAgentRecipeCatalog | null; pending: boolean; loading: boolean;
  error: string; connectionError: string;
  onChange(recipe: ChatAgentRecipe): void; onRetry(): void;
}) {
  return <section className="grid gap-2 rounded-xl border p-3" aria-labelledby={`${ids}-title`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h3 id={`${ids}-title`} className="text-sm font-medium">Recipe</h3>
        <p className="mt-1 text-xs" style={muted}>{removing
          ? "This saved recipe will be removed when you save."
          : "Optionally guide repeat work with pinned skills, connected sources, and an expected output."}</p>
      </div>
      {catalog?.enabled ? <button type="button" className={button} disabled={pending || loading}
        onClick={() => onChange({ skills: [], integrations: [], output: "" })}>Add recipe</button> : null}
    </div>
    {loading ? <p role="status" className="text-xs" style={muted}>Loading recipe options…</p> : null}
    {error || connectionError ? <div className="flex flex-wrap items-center gap-2">
      <div className="grid gap-1">{error ? <p className="text-xs">Recipe options are unavailable.</p> : null}
        {connectionError ? <p className="text-xs">Connection status is unavailable. Saved account choices are preserved.</p> : null}</div>
      <button type="button" className={button} disabled={pending || loading} onClick={onRetry}>Retry recipe options</button>
    </div> : null}
    {!loading && !error && catalog && !catalog.enabled
      ? <p className="text-xs" style={muted}>Recipes are unavailable on this computer.</p> : null}
  </section>;
}

export function AgentRecipeEditor({ recipe, hadRecipe, catalog, connections, loading, error, connectionError, pending, onChange, onRetry }: {
  recipe: ChatAgentRecipe | null | undefined;
  hadRecipe: boolean;
  catalog: ChatAgentRecipeCatalog | null;
  connections: ChatAgentIntegrationConnection[];
  loading: boolean;
  error: string;
  connectionError: string;
  pending: boolean;
  onChange(recipe: ChatAgentRecipe | null | undefined): void;
  onRetry(): void;
}) {
  const ids = useId();
  const configured = recipe !== null && recipe !== undefined;
  if (!configured) return <EmptyRecipe ids={ids} removing={recipe === null && hadRecipe} catalog={catalog} pending={pending}
    loading={loading} error={error} connectionError={connectionError} onChange={onChange} onRetry={onRetry} />;

  const catalogSkills = catalog?.skills ?? [];
  const missingSkillIds = recipe.skills.filter((id) => !catalogSkills.some((skill) => skill.id === id));

  return <section className="grid min-w-0 gap-4 rounded-xl border p-3" aria-labelledby={`${ids}-title`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0">
        <h3 id={`${ids}-title`} className="text-sm font-medium">Recipe</h3>
        <p className="mt-1 text-xs" style={muted}>Selections guide this workflow. Hermes still uses the existing Full access mode when you send a request.</p>
      </div>
      <button type="button" className={button} disabled={pending} onClick={() => onChange(hadRecipe ? null : undefined)}>Remove recipe</button>
    </div>

    {loading ? <p role="status" className="text-xs" style={muted}>Refreshing recipe options…</p> : null}
    {error || connectionError ? <div className="flex flex-wrap items-center gap-2">
      <div className="grid gap-1">{error ? <p className="text-xs">Recipe options are unavailable. Saved selections are preserved.</p> : null}
        {connectionError ? <p className="text-xs">Connection status is unavailable. Saved account choices are preserved.</p> : null}</div>
      <button type="button" className={button} disabled={pending || loading} onClick={onRetry}>Retry recipe options</button>
    </div> : null}

    <fieldset className="grid gap-2">
      <legend className="text-sm font-medium">Skills</legend>
      {catalogSkills.map((skill) => <label key={skill.id} className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-sm">
        <input type="checkbox" aria-label={skill.name} className="mt-0.5" checked={recipe.skills.includes(skill.id)} disabled={pending}
          onChange={(event) => onChange({ ...recipe, skills: event.target.checked
            ? [...recipe.skills, skill.id]
            : recipe.skills.filter((id) => id !== skill.id) })} />
        <span className="min-w-0 truncate" title={skill.name}>{skill.name}</span>
        <span className="col-start-2 text-xs" style={muted}>{skill.description}</span>
      </label>)}
      {missingSkillIds.map((skillId) => <label key={skillId} className="flex min-w-0 items-center gap-2 text-sm">
        <input type="checkbox" checked disabled={pending}
          onChange={() => onChange({ ...recipe, skills: recipe.skills.filter((id) => id !== skillId) })} />
        <span className="min-w-0 truncate" title={skillId}>{skillId} · unavailable</span>
      </label>)}
      {!catalogSkills.length && !missingSkillIds.length ? <p className="text-xs" style={muted}>No skills selected.</p> : null}
    </fieldset>

    <AgentRecipeIntegrations recipe={recipe} catalog={catalog} connections={connections} connectionError={connectionError}
      pending={pending} onChange={onChange} />

    <label className="grid gap-1 text-sm" htmlFor={`${ids}-output`}>Expected output
      <textarea id={`${ids}-output`} className={`${input} min-h-24 resize-y`} value={recipe.output} maxLength={1000}
        required disabled={pending} placeholder="Describe the result this Agent should produce."
        onChange={(event) => onChange({ ...recipe, output: event.target.value })} />
    </label>
  </section>;
}
