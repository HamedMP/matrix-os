import { useId } from "react";
import type { ChatAgentRecipe, ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import type { ChatAgentIntegrationConnection } from "./client.js";

const button = "rounded-lg border px-3 py-2 text-sm outline-none hover:enabled:bg-[var(--bg-hover,var(--matrix-secondary))] focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))] disabled:opacity-50";
const input = "w-full min-w-0 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))]";
const muted = { color: "var(--text-secondary, var(--matrix-muted-fg))" };

function serviceName(service: string, catalog: ChatAgentRecipeCatalog | null): string {
  const known = catalog?.services.find((candidate) => candidate.id === service)?.name;
  if (known) return known;
  return service.split("_").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function activeConnections(service: string, connections: ChatAgentIntegrationConnection[]) {
  return connections.filter((connection) => connection.service === service && connection.status === "active");
}

export function accountForNewIntegration(service: string, connections: ChatAgentIntegrationConnection[]): string | undefined {
  const active = activeConnections(service, connections);
  return active.length === 1 ? active[0]!.account_label : undefined;
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
  if (!configured) return <section className="grid gap-2 rounded-xl border p-3" aria-labelledby={`${ids}-title`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0">
        <h3 id={`${ids}-title`} className="text-sm font-medium">Recipe</h3>
        <p className="mt-1 text-xs" style={muted}>{recipe === null && hadRecipe
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

  const catalogSkills = catalog?.skills ?? [];
  const missingSkillIds = recipe.skills.filter((id) => !catalogSkills.some((skill) => skill.id === id));
  const availableConnections = connectionError ? [] : connections;
  const addIntegration = (service: string) => {
    if (!service || recipe.integrations.length >= 8) return;
    const accountLabel = accountForNewIntegration(service, availableConnections);
    onChange({ ...recipe, integrations: [...recipe.integrations, {
      service,
      ...(accountLabel ? { accountLabel } : {}),
    }] });
  };

  return <section className="grid max-h-96 gap-4 overflow-y-auto overscroll-contain rounded-xl border p-3" aria-labelledby={`${ids}-title`}>
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

    <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">Integrations</legend>
      {recipe.integrations.map((integration, index) => {
        const name = serviceName(integration.service, catalog);
        const serviceAvailable = Boolean(catalog?.services.some((service) => service.id === integration.service));
        const active = activeConnections(integration.service, availableConnections);
        const selected = integration.accountLabel;
        const selectedConnection = selected
          ? availableConnections.find((connection) => connection.service === integration.service && connection.account_label === selected)
          : undefined;
        const selectedStatusUnknown = Boolean(connectionError && selected);
        const selectedUnavailable = Boolean(!connectionError && selected && selectedConnection?.status !== "active");
        return <div key={`${integration.service}:${index}`} className="grid min-w-0 gap-2 rounded-lg border p-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 truncate text-sm font-medium" title={serviceAvailable ? name : `${name} · unavailable`}>
              {name}{serviceAvailable ? "" : " · unavailable"}
            </span>
            <button type="button" className={button} disabled={pending} aria-label={`Remove ${name}`}
              onClick={() => onChange({ ...recipe, integrations: recipe.integrations.filter((_, candidate) => candidate !== index) })}>Remove</button>
          </div>
          <label className="grid gap-1 text-xs" htmlFor={`${ids}-account-${index}`}>{name} account
            <select id={`${ids}-account-${index}`} className={input} value={selected ?? ""} disabled={pending}
              onChange={(event) => onChange({ ...recipe, integrations: recipe.integrations.map((candidate, candidateIndex) =>
                candidateIndex === index ? { service: candidate.service,
                  ...(event.target.value ? { accountLabel: event.target.value } : {}) } : candidate) })}>
              <option value="">Ask when run</option>
              {selectedStatusUnknown ? <option value={selected}>{selected} · status unavailable</option> : null}
              {selectedUnavailable ? <option value={selected}>{selected} · unavailable</option> : null}
              {active.map((connection) => <option key={connection.account_label} value={connection.account_label}>
                {connection.account_label}{connection.account_email ? ` · ${connection.account_email}` : ""}
              </option>)}
            </select>
          </label>
          {!serviceAvailable ? <p className="text-xs" style={muted}>Saved integration is unavailable. It will be kept until you remove it.</p>
            : connectionError ? <p className="text-xs" style={muted}>{selected
              ? "Account status could not be verified. Your saved choice is preserved."
              : "Account status could not be verified. Keep Ask when run or retry."}</p>
            : selectedUnavailable ? <p className="text-xs" style={muted}>Saved account is unavailable. It will be kept until you choose another account.</p>
            : active.length === 0 ? <p className="text-xs" style={muted}>No connected account. Connect {name} before this workflow can read it.</p>
              : active.length > 1 && !selected ? <p className="text-xs" style={muted}>Choose an account or keep Ask when run.</p>
                : <p className="text-xs" style={muted}>Connected.</p>}
        </div>;
      })}
      {catalog?.services.length ? <label className="grid gap-1 text-xs" htmlFor={`${ids}-integration`}>Add integration
        <select id={`${ids}-integration`} className={input} value="" disabled={pending || recipe.integrations.length >= 8}
          onChange={(event) => addIntegration(event.target.value)}>
          <option value="">Choose a service</option>
          {catalog.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
        </select>
      </label> : null}
    </fieldset>

    <label className="grid gap-1 text-sm" htmlFor={`${ids}-output`}>Expected output
      <textarea id={`${ids}-output`} className={`${input} min-h-24 resize-y`} value={recipe.output} maxLength={1000}
        required disabled={pending} placeholder="Describe the result this Agent should produce."
        onChange={(event) => onChange({ ...recipe, output: event.target.value })} />
    </label>
  </section>;
}
