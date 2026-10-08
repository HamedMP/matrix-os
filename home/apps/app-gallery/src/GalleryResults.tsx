import React from "react";
import Preview, { Icon } from "./Preview";
import AppIdentity from "./AppIdentity";
import { galleryArtwork } from "./artwork";
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
function AppCard({ app, props }: { app: GalleryAppListing; props: Props }) {
  const error = props.actionErrors[app.id] ?? "";
  return (
    <article className="gallery-card" aria-labelledby={`gallery-title-${app.id}`}>
      <button className="card-preview" aria-label={`Explore ${app.name}`} onClick={() => props.onSelect(app.id)}><Preview app={app} /></button>
      <div className="card-info">
        <button className="card-identity" aria-label={`Details for ${app.name}`} onClick={() => props.onSelect(app.id)}><AppIdentity app={app} /><div><h2 id={`gallery-title-${app.id}`}>{app.name}</h2><p>{app.tagline}</p></div></button>
        <Action app={app} pending={props.pending} error={error} onAction={props.onAction} />
      </div>
      <div className="card-connections"><span>{app.services.every(service => service.optional) ? "Optional" : "Works with"}</span>
        {app.services.length ? app.services.map(service => {
          const symbol = /calendar/.test(service.id) ? "calendar" : service.id === "gmail" ? "mail" : /drive|docs/.test(service.id) ? "folder" : null;
          return <span className="service-chip" key={service.id}>{symbol && <img src={galleryArtwork(`controls/${symbol}.svg`)} alt="" />}{service.name}</span>;
        }) : <span className="service-chip">Your own entries</span>}
      </div>
      <div className="card-readiness"><ConnectionLabel app={app} connections={props.connections} /></div>
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
  const preferred = props.collection === "personal" ? ["folio", "subscriptions", "agenda"] : ["cashflow", "projects", "meeting-briefs"];
  const ordered = [...preferred.flatMap(id => props.apps.filter(app => app.id === id)), ...props.apps.filter(app => !preferred.includes(app.id))];
  return (
    <section className="gallery-results" aria-label={`${props.collection === "personal" ? "Personal" : "Business"} apps`} aria-busy={props.loading}>
      <div className="gallery-grid">{ordered.map(app => <AppCard key={app.id} app={app} props={props} />)}</div>
    </section>
  );
}
