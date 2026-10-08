import React from "react";
import Preview, { Icon } from "./Preview";
import AppIdentity from "./AppIdentity";
import { deriveGalleryReadiness, type GalleryAppListing, type GalleryConnection } from "./model";
interface Props {
  apps: GalleryAppListing[];
  connections: GalleryConnection[] | null;
  loading: boolean;
  error: string;
  collection: string;
  bridgeUnavailable: boolean;
  pending: string | null;
  actionErrors: Record<string, string>;
  onSelect: (id: string) => void;
  onAction: (app: GalleryAppListing) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClear: () => void;
}
const readinessLabels = {
  ready: "Connections ready",
  choose_accounts: "Choose accounts after install",
  needs_connection: "Connection needed",
  unknown: "Connections not checked",
};
function ConnectionLabel({ app, connections }: { app: GalleryAppListing; connections: GalleryConnection[] | null }) {
  const readiness = deriveGalleryReadiness(app, connections);
  return (
    <span className={`readiness readiness-${readiness.status}`}>
      <i aria-hidden="true" />
      <span>{app.services.length ? app.services.map(service => service.name).join(", ") : "No connection needed"}
        {app.services.length > 0 && <small>{readinessLabels[readiness.status]}</small>}
      </span>
    </span>
  );
}
function Action({ app, pending, error, onAction }: Pick<Props, "pending" | "onAction"> & { app: GalleryAppListing; error: string }) {
  return (
    <button className={app.installed ? "open-button" : "install-button"} onClick={() => void onAction(app)} disabled={pending !== null} aria-describedby={`gallery-title-${app.id}`} aria-busy={pending === app.id}>
      {pending === app.id ? "Installing…" : app.installed ? "Open" : error ? "Retry" : "Get"}
    </button>
  );
}
function Installed({ app }: { app: GalleryAppListing }) {
  return app.installed ? <span className="installed-badge"><Icon name="check" />Installed</span> : null;
}
function AppCard({ app, props, featured }: { app: GalleryAppListing; props: Props; featured: boolean }) {
  const error = props.actionErrors[app.id] ?? "";
  if (featured) return (
    <article className="featured-app" aria-labelledby={`gallery-title-${app.id}`}>
      <button className="featured-explore" aria-label={`Explore ${app.name}`} onClick={() => props.onSelect(app.id)}>
        <Preview app={app} />
        <div className="featured-copy"><AppIdentity app={app} /><div><h2 id={`gallery-title-${app.id}`}>{app.name}</h2><p>{app.tagline}</p><Installed app={app} /></div></div>
      </button>
      <footer className="card-footer"><ConnectionLabel app={app} connections={props.connections} /><Action app={app} pending={props.pending} error={error} onAction={props.onAction} /></footer>
      {error && <p className="card-error" role="alert">{error}</p>}
    </article>
  );
  return (
    <article className="app-row" aria-labelledby={`gallery-title-${app.id}`}>
      <button className="row-explore" aria-label={`Explore ${app.name}`} onClick={() => props.onSelect(app.id)}>
        <AppIdentity app={app} /><div className="app-row-copy"><h2 id={`gallery-title-${app.id}`}>{app.name}</h2><p className="app-row-category">{app.category}</p><p className="row-description">{app.description}</p><Installed app={app} /></div>
      </button>
      <Action app={app} pending={props.pending} error={error} onAction={props.onAction} />
      <div className="row-support"><ConnectionLabel app={app} connections={props.connections} /></div>
      {error && <p className="card-error" role="alert">{error}</p>}
    </article>
  );
}
export default function GalleryResults(props: Props) {
  if (props.error) return (
    <div className="empty" role="alert"><Icon name="grid" /><h2>{props.bridgeUnavailable ? "Open App Gallery in Matrix." : "The gallery could not load."}</h2><p>{props.error}</p>
      {!props.bridgeUnavailable && <button className="primary-button" onClick={() => void props.onRefresh()}>Try again</button>}
    </div>
  );
  if (props.loading && !props.apps.length) return (
    <div className="gallery-loading" aria-label="Loading apps" aria-busy="true">{[0, 1].map(i => <div className="skeleton" key={i}><div /><span /><span /></div>)}</div>
  );
  if (!props.apps.length) return (
    <div className="empty"><Icon name="search" /><h2>No apps match your filters.</h2><p>Try another search or explore the whole collection.</p><button className="primary-button" onClick={props.onClear}>Clear filters</button></div>
  );
  const preferred = props.collection === "business" ? ["cashflow", "projects"] : ["folio", "atlas"];
  const ordered = [...props.apps.filter(app => preferred.includes(app.id)), ...props.apps.filter(app => !preferred.includes(app.id))];
  const featured = ordered.slice(0, 2), remaining = props.apps.filter(app => !featured.some(item => item.id === app.id));
  return (
    <section className="gallery-results" aria-label={`${props.collection === "personal" ? "Personal" : "Business"} apps`} aria-busy={props.loading}>
      <section className="featured-shelf" aria-label="Featured apps">{featured.map(app => <AppCard key={app.id} app={app} props={props} featured />)}</section>
      {remaining.length > 0 && <div className="app-list">{remaining.map(app => <AppCard key={app.id} app={app} props={props} featured={false} />)}</div>}
    </section>
  );
}
