import { useId } from "react";
import type { ChatAgentRecipe, ChatAgentRecipeCatalog } from "@matrix-os/contracts";
import type { ChatAgentIntegrationConnection } from "./client.js";
import { accountForNewIntegration, activeConnections, integrationConnectionMessage, serviceName } from "./recipe-integrations.js";

const button = "rounded-lg border px-3 py-2 text-sm outline-none hover:enabled:bg-[var(--bg-hover,var(--matrix-secondary))] focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))] disabled:opacity-50";
const input = "w-full min-w-0 rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent,var(--matrix-accent))]";
const muted = { color: "var(--text-secondary, var(--matrix-muted-fg))" };

function IntegrationRow({ recipe, integration, index, ids, catalog, availableConnections, connectionError, pending, onChange }: {
  recipe: ChatAgentRecipe; integration: ChatAgentRecipe["integrations"][number]; index: number; ids: string;
  catalog: ChatAgentRecipeCatalog | null; availableConnections: ChatAgentIntegrationConnection[];
  connectionError: string; pending: boolean; onChange(recipe: ChatAgentRecipe): void;
}) {
  const duplicate = recipe.integrations.some((candidate, candidateIndex) => candidateIndex !== index
    && candidate.service === integration.service && candidate.accountLabel === integration.accountLabel);
  const name = serviceName(integration.service, catalog);
  const serviceAvailable = Boolean(catalog?.services.some((service) => service.id === integration.service));
  const active = activeConnections(integration.service, availableConnections);
  const selected = integration.accountLabel;
  const selectedConnection = selected
    ? availableConnections.find((connection) => connection.service === integration.service && connection.account_label === selected)
    : undefined;
  const selectedStatusUnknown = Boolean(connectionError && selected);
  const selectedUnavailable = Boolean(!connectionError && selected && selectedConnection?.status !== "active");
  return <div className="grid min-w-0 gap-2 rounded-lg border p-2">
    <div className="flex min-w-0 items-center justify-between gap-2">
      <span className="min-w-0 truncate text-sm font-medium" title={serviceAvailable ? name : `${name} · unavailable`}>
        {name}{serviceAvailable ? "" : " · unavailable"}
      </span>
      <button type="button" className={button} disabled={pending} aria-label={`Remove ${name}`}
        onClick={() => onChange({ ...recipe, integrations: recipe.integrations.filter((_, candidate) => candidate !== index) })}>Remove</button>
    </div>
    <label className="grid gap-1 text-xs" htmlFor={`${ids}-account-${index}`}>{name} account
      <select id={`${ids}-account-${index}`} className={input} aria-invalid={duplicate} aria-describedby={duplicate ? `${ids}-duplicate-${index}` : undefined} value={selected ?? ""} disabled={pending}
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
    {duplicate ? <p role="alert" id={`${ids}-duplicate-${index}`} className="text-xs">Choose a different account or remove this duplicate integration.</p> : null}
    <p className="text-xs" style={muted}>{integrationConnectionMessage({ name, serviceAvailable, connectionError,
      selected, selectedUnavailable, accountCount: active.length })}</p>
  </div>;
}

export function AgentRecipeIntegrations({ recipe, catalog, connections, connectionError, pending, onChange }: {
  recipe: ChatAgentRecipe; catalog: ChatAgentRecipeCatalog | null;
  connections: ChatAgentIntegrationConnection[]; connectionError: string; pending: boolean;
  onChange(recipe: ChatAgentRecipe): void;
}) {
  const ids = useId();
  const availableConnections = connectionError ? [] : connections;
  const addIntegration = (service: string) => {
    if (!service || recipe.integrations.length >= 8) return;
    const accountLabel = accountForNewIntegration(service, availableConnections);
    onChange({ ...recipe, integrations: [...recipe.integrations, {
      service,
      ...(accountLabel ? { accountLabel } : {}),
    }] });
  };
  return <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">Integrations</legend>
      {recipe.integrations.map((integration, index) => <IntegrationRow key={`${integration.service}:${index}`} recipe={recipe}
        integration={integration} index={index} ids={ids} catalog={catalog} availableConnections={availableConnections}
        connectionError={connectionError} pending={pending} onChange={onChange} />)}
      {catalog?.services.length ? <label className="grid gap-1 text-xs" htmlFor={`${ids}-integration`}>Add integration
        <select id={`${ids}-integration`} className={input} value="" disabled={pending || recipe.integrations.length >= 8}
          onChange={(event) => addIntegration(event.target.value)}>
          <option value="">Choose a service</option>
          {catalog.services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}
        </select>
      </label> : null}
    </fieldset>;
}
