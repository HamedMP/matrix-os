import React, { useEffect, useRef } from "react";
import { deriveGalleryReadiness, type GalleryAppListing, type GalleryConnection } from "./model";
import AppIdentity from "./AppIdentity";
import Preview from "./Preview";
import { galleryArtwork } from "./artwork";
import "./GalleryDetail.css";

export interface GalleryDetailProps {
  app: GalleryAppListing;
  connections: GalleryConnection[] | null;
  pending: string | null;
  error: string;
  onClose: () => void;
  onAction: () => void;
}

const statusLabels = {
  ready: "Connections ready",
  choose_accounts: "Choose accounts after install",
  needs_connection: "Connection needed",
  unknown: "Connections not checked",
};

function DetailIcon({ name }: { name: "back" | "mail" | "eye" | "shield" | "lock" }) {
  return <img className="gallery-detail-icon" src={galleryArtwork(`detail/${name}.svg`)} alt="" />;
}

/** Catalog-backed details share the existing owner-scoped install/open actions. */
export default function GalleryDetail({ app, connections, pending, error, onClose, onAction }: GalleryDetailProps) {
  const title = useRef<HTMLHeadingElement>(null);
  const readiness = deriveGalleryReadiness(app, connections);
  useEffect(() => { title.current?.focus(); }, [app.id]);
  const actionLabel = pending === app.id ? "Installing…" : app.installed ? "Open app" : error ? "Retry installation" : "Get app";
  return (
    <section className="gallery-detail" aria-labelledby="gallery-detail-title" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    }}>
      <button className="gallery-detail-back" aria-label="Back to gallery" onClick={onClose}>
        <DetailIcon name="back" /> Gallery
      </button>
      <header className="gallery-detail-hero">
        <AppIdentity app={app} />
        <div className="gallery-detail-title-group">
          <h1 id="gallery-detail-title" ref={title} tabIndex={-1}>{app.name}</h1>
          <p>{app.tagline}</p>
          <div className="gallery-detail-actions">
            <button className="gallery-detail-action" aria-label={actionLabel} onClick={onAction} disabled={pending !== null}>
              {pending === app.id ? "Installing…" : app.installed ? "Open" : error ? "Retry" : "Get"}
            </button>
            <span className="gallery-detail-readiness" role="status">
              {app.installed ? "Already on your computer" : statusLabels[readiness.status]}
            </span>
          </div>
          {error && <p className="gallery-detail-error" role="alert">{error}</p>}
        </div>
      </header>
      <dl className="gallery-detail-facts">
        <div>
          <dt>{app.services.length ? app.services.every(service => service.optional) ? "Optional sources" : "Works with" : "Connections"}</dt>
          <dd>{app.services.length > 0 && <DetailIcon name="mail" />}{app.services.length ? app.services.map(service => service.name).join(", ") : "No external connection required"}</dd>
        </div>
        <div><dt>Category</dt><dd>{app.category}</dd></div>
        <div><dt>Runs on</dt><dd>Web Desktop · Web Canvas · Electron Desktop · Web Mobile</dd></div>
      </dl>
      <div className="gallery-detail-previews">
        <Preview app={app} large />
        <section className="gallery-detail-at-a-glance" aria-labelledby="gallery-detail-glance-title">
          <div>
            <h2 id="gallery-detail-glance-title">At a glance</h2>
            <p>{app.description}</p>
            <ul>{app.highlights.map(highlight => <li key={highlight}>{highlight}</li>)}</ul>
          </div>
        </section>
      </div>
      <section className="gallery-detail-access" aria-labelledby="gallery-detail-access-title">
        <h2 id="gallery-detail-access-title">Access</h2>
        <div className="gallery-detail-access-columns">
          <div>
            <h3><DetailIcon name="eye" /> Reads</h3>
            <ul>
              <li>Records you add to this app</li>
              {app.services.map(service => <li key={service.id}>Sources you select · {service.name}{service.optional ? " (optional)" : ""}</li>)}
            </ul>
          </div>
          <div>
            <h3><DetailIcon name="shield" /> You control</h3>
            <ul>
              <li>Add, edit and export your own records.</li>
              {app.services.length > 0 && <li>Imports happen only when you ask Matrix and choose accounts.</li>}
            </ul>
          </div>
        </div>
        <p className="gallery-detail-manual"><DetailIcon name="lock" /> Works without connections. Add your own records anytime.</p>
      </section>
      {readiness.services.length > 0 && (
        <section className="gallery-detail-connections" aria-labelledby="gallery-detail-connections-title">
          <h2 id="gallery-detail-connections-title">Your connections</h2>
          <p className="gallery-detail-connections-note">Installing this app does not connect or import accounts.</p>
          {readiness.services.map(service => {
            const optional = app.services.find(source => source.id === service.id)?.optional;
            return <div className="gallery-detail-connection" key={service.id}>
              <div>
                <h3>{service.name}</h3>
                {optional && <p className="gallery-detail-optional">Optional source</p>}
                {connections === null ? <p>Connection inventory unavailable</p> : service.accounts.length ? (
                  <ul>{service.accounts.map((account, index) => <li key={`${account.account_label}:${account.account_email ?? ""}:${index}`}>
                    {account.account_label}{account.account_email ? ` (${account.account_email})` : ""}
                  </li>)}</ul>
                ) : <p>No connected account</p>}
              </div>
              <span className={`gallery-detail-connection-state${service.accounts.length ? " gallery-detail-connection-active" : ""}`}>
                {connections === null ? "Unknown" : service.accounts.length ? `${service.accounts.length} ${service.accounts.length === 1 ? "account" : "accounts"}` : optional ? "Optional" : "Not connected"}
              </span>
            </div>;
          })}
        </section>
      )}
      <p className="gallery-detail-owner-note">Apps start empty. Records stay in your Matrix database.</p>
    </section>
  );
}
