"use client";

import { useState, type ReactNode } from "react";
import { buildIntegrationSections, integrationAuthType, integrationDescription, type IntegrationCatalogItem } from "@matrix-os/contracts/integration-marketplace";

const muted = { color: "var(--text-tertiary, var(--muted-foreground))" };
const pill = { background: "var(--bg-surface-hover, var(--muted))" };

export function IntegrationMarketplace<T extends IntegrationCatalogItem>({
  services, connectedIds, connectingId, onConnect, renderService,
}: {
  services: readonly T[];
  connectedIds: readonly string[];
  connectingId?: string | null;
  onConnect: (id: string) => void;
  renderService?: (service: T) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [oauthOnly, setOauthOnly] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const sections = buildIntegrationSections(services, { query, oauthOnly, connectedOnly, connectedIds });
  const connectedCount = services.filter(service => connectedIds.includes(service.id)).length;

  return (
    <div className="space-y-8" data-testid="integrations-grid">
      <div className="space-y-4">
        <div className="flex items-center gap-3 rounded-full border px-4 py-3" style={{ borderColor: "var(--border-subtle, var(--border))", ...pill }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true" style={muted}>
            <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" />
          </svg>
          <input type="search" aria-label="Search integrations" placeholder="Search apps" value={query} onChange={e => setQuery(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm outline-none focus-visible:ring-2 focus-visible:ring-current rounded-sm" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-1" aria-label="App catalog filters">
            <button type="button" aria-pressed={!connectedOnly} onClick={() => setConnectedOnly(false)} className="rounded-full px-4 py-2 text-sm focus-visible:outline-2" style={!connectedOnly ? pill : muted}>All apps</button>
            <button type="button" aria-pressed={connectedOnly} onClick={() => setConnectedOnly(true)} className="rounded-full px-4 py-2 text-sm focus-visible:outline-2" style={connectedOnly ? pill : muted}>Connected ({connectedCount})</button>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs" style={muted}>
            <input type="checkbox" checked={oauthOnly} onChange={e => setOauthOnly(e.target.checked)} />Sign in without API keys
          </label>
        </div>
      </div>
      {sections.map(section => {
        const showAll = query.trim() || connectedOnly || oauthOnly || expanded.includes(section.title);
        const visible = showAll ? section.services : section.services.slice(0, 4);
        return (
          <section key={section.title} aria-label={section.title} className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-base font-medium">{section.title}</h3>
              {!showAll && section.services.length > 4 ? (
                <button type="button" aria-label={`View all ${section.title} apps`} onClick={() => setExpanded(previous => [...previous, section.title])}
                  className="text-sm underline-offset-4 hover:underline focus-visible:outline-2" style={muted}>View all</button>
              ) : null}
            </div>
            <div className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
              {visible.map(service => renderService ? <div key={service.id}>{renderService(service)}</div> : (
                <MarketplaceRow key={service.id} service={service} connected={connectedIds.includes(service.id)} connecting={connectingId === service.id}
                  disabled={Boolean(connectingId)} onConnect={() => onConnect(service.id)} />
              ))}
            </div>
          </section>
        );
      })}
      {sections.length === 0 ? (
        <div className="py-10 text-center" role="status">
          <p className="text-sm font-medium">{services.length === 0 ? "No apps available" : "No integrations found"}</p>
          <p className="mt-2 text-sm" style={muted}>{services.length === 0 ? "Refresh to try again." : "Try another search or change the filters."}</p>
        </div>
      ) : null}
    </div>
  );
}

function MarketplaceRow({ service, connected, connecting, disabled, onConnect }: {
  service: IntegrationCatalogItem; connected: boolean; connecting: boolean; disabled: boolean; onConnect: () => void;
}) {
  const auth = integrationAuthType(service);
  return (
    <div className="flex min-w-0 items-center gap-3 py-4" data-testid={`integration-card-${service.id}`}>
      <MarketplaceIcon key={service.logoUrl} name={service.name} logoUrl={service.logoUrl} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{service.name}</p>
        <p className="mt-1 truncate text-sm" style={muted} title={integrationDescription(service)}>{integrationDescription(service)}</p>
        <p className="mt-1 text-xs" style={muted}>{auth === "keys" ? "API key required" : auth === "oauth" ? "Sign in securely" : "Connect your account"}</p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {connected ? <span className="text-xs" style={{ color: "var(--surface-success-emphasis, var(--primary))" }}>✓ Connected</span> : null}
        <button type="button" aria-label={connected ? `Add another ${service.name} account` : `Connect ${service.name}`} disabled={disabled} onClick={onConnect}
          className="rounded-full px-4 py-2 text-sm transition-opacity hover:opacity-75 disabled:opacity-50 focus-visible:outline-2" style={pill}>
          {connecting ? "Connecting…" : connected ? "Add account" : "Connect"}
        </button>
      </div>
    </div>
  );
}

function MarketplaceIcon({ name, logoUrl }: { name: string; logoUrl?: string }) {
  const [imageFailed, setImageFailed] = useState(false);
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl" style={pill}>
      {logoUrl && !imageFailed ? (
        <img src={logoUrl} alt="" width={48} height={48} className="size-12 object-contain" referrerPolicy="no-referrer" onError={() => setImageFailed(true)} />
      ) : <span className="text-xl font-medium" aria-hidden="true">{name.charAt(0)}</span>}
    </div>
  );
}
