"use client";

import { useState, type ReactNode } from "react";
import { buildIntegrationSections, integrationAuthType, integrationDescription, type IntegrationCatalogItem } from "@matrix-os/contracts/integration-marketplace";

const muted = { color: "var(--text-tertiary, var(--muted-foreground))" };
const pill = { background: "var(--bg-surface-hover, var(--muted))" };

export function IntegrationMarketplace<T extends IntegrationCatalogItem>({
  services, connectedIds, connectingId, onConnect, renderService, leadingSection, failedIds, lockWhileConnecting = true,
}: {
  services: readonly T[];
  connectedIds: readonly string[];
  connectingId?: string | null;
  onConnect: (id: string) => void;
  renderService?: (service: T) => ReactNode;
  /** An optional first section of chosen apps, shown in full (e.g. Get started's suggestions). */
  leadingSection?: { title: string; ids: readonly string[] };
  /** Apps whose last sign-in did not finish; their rows say so and offer Try again. */
  failedIds?: readonly string[];
  /**
   * Settings locks every Connect while a sign-in is pending. Get started keeps them all usable,
   * so a cancelled or stuck sign-in never blocks the next app; a new connect replaces it.
   */
  lockWhileConnecting?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [oauthOnly, setOauthOnly] = useState(false);
  const [expanded, setExpanded] = useState<string[]>([]);
  const failed = new Set(failedIds);
  const sections = buildIntegrationSections(services, { query, oauthOnly, connectedOnly, connectedIds, ...(leadingSection ? { leading: leadingSection } : {}) });
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
        const showAll = query.trim() || connectedOnly || oauthOnly || expanded.includes(section.title) || section.title === leadingSection?.title;
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
                  failed={failed.has(service.id)} disabled={lockWhileConnecting && Boolean(connectingId)} onConnect={() => onConnect(service.id)} />
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

type RowState = "adding" | "connected" | "connecting" | "failed" | "idle";

/** The row's button for its state; a failed sign-in says so and offers Try again. */
const ROW_BUTTON: Record<RowState, { label: (name: string) => string; text: string }> = {
  adding: { label: (name) => `Add another ${name} account`, text: "Connecting…" },
  connected: { label: (name) => `Add another ${name} account`, text: "Add account" },
  connecting: { label: (name) => `Connect ${name}`, text: "Connecting…" },
  failed: { label: (name) => `Try connecting ${name} again`, text: "Try again" },
  idle: { label: (name) => `Connect ${name}`, text: "Connect" },
};

function rowState(connected: boolean, connecting: boolean, failed: boolean): RowState {
  if (connecting) return connected ? "adding" : "connecting";
  if (connected) return "connected";
  return failed ? "failed" : "idle";
}

function MarketplaceRow({ service, connected, connecting, failed, disabled, onConnect }: {
  service: IntegrationCatalogItem; connected: boolean; connecting: boolean; failed: boolean; disabled: boolean; onConnect: () => void;
}) {
  const auth = integrationAuthType(service);
  const state = rowState(connected, connecting, failed);
  const button = ROW_BUTTON[state];
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
        {state === "failed" ? <span className="text-xs" role="status" style={{ color: "var(--surface-danger-emphasis, var(--destructive))" }}>Sign-in didn't finish</span> : null}
        <button type="button" aria-label={button.label(service.name)} disabled={disabled} onClick={onConnect}
          className="rounded-full px-4 py-2 text-sm transition-opacity hover:opacity-75 disabled:opacity-50 focus-visible:outline-2" style={pill}>
          {button.text}
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
