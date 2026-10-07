import Preview, { Glyph, Icon } from "./Preview";
import {
  deriveGalleryReadiness,
  type GalleryAppListing,
  type GalleryConnection,
} from "./model";
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
function AppCard({
  app,
  connections,
  pending,
  error,
  onSelect,
  onAction,
}: {
  app: GalleryAppListing;
  connections: GalleryConnection[] | null;
  pending: string | null;
  error: string;
  onSelect: (id: string) => void;
  onAction: (app: GalleryAppListing) => Promise<void>;
}) {
  const readiness = deriveGalleryReadiness(app, connections);
  const label =
    pending === app.id
      ? "Installing…"
      : app.installed
        ? "Open"
        : error
          ? "Retry"
          : "Install";
  const titles = {
    ready: "Connections ready",
    choose_accounts: "Choose accounts after install",
    needs_connection: "Connection needed",
    unknown: "Connections not checked",
  };
  return (
    <article className="app-card">
      <button
        className="explore"
        onClick={() => onSelect(app.id)}
        aria-label={`Explore ${app.name}`}
      >
        <Preview app={app} />
        <div className="app-heading">
          <span className="app-symbol">
            <Glyph view={app.view} />
          </span>
          <div>
            <h2>{app.name}</h2>
            <p>{app.category}</p>
          </div>
          {app.installed && (
            <span className="installed-badge">
              <Icon name="check" />
              Installed
            </span>
          )}
        </div>
        <p className="card-description">{app.description}</p>
      </button>
      <footer className="card-footer">
        <span
          className={`readiness readiness-${readiness.status}`}
          title={titles[readiness.status]}
        >
          <i />
          {app.services.length
            ? app.services.map((service) => service.name).join(" + ")
            : "No connection needed"}
        </span>
        <button
          className={app.installed ? "open-button" : "install-button"}
          onClick={() => void onAction(app)}
          disabled={pending !== null}
        >
          {label}
          {app.installed && <Icon name="arrow" />}
        </button>
      </footer>
      {error && (
        <p className="card-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}
export default function GalleryResults(props: Props) {
  if (props.error)
    return (
      <div className="empty">
        <Icon name="grid" />
        <h2>
          {props.bridgeUnavailable
            ? "App Gallery needs a supported Matrix view."
            : "The gallery is temporarily unavailable."}
        </h2>
        <p>{props.error}</p>
        {!props.bridgeUnavailable && (
          <button
            className="primary-button"
            onClick={() => void props.onRefresh()}
          >
            Try again
          </button>
        )}
      </div>
    );
  if (props.loading && !props.apps.length)
    return (
      <div className="gallery-grid" aria-label="Loading apps" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="skeleton" key={i}>
            <div />
            <span />
            <span />
          </div>
        ))}
      </div>
    );
  if (!props.apps.length)
    return (
      <div className="empty">
        <Icon name="search" />
        <h2>No apps match your filters.</h2>
        <p>Try another search or explore the whole collection.</p>
        <button className="primary-button" onClick={props.onClear}>
          Clear filters
        </button>
      </div>
    );
  return (
    <section
      className="gallery-grid"
      aria-label={`${props.collection === "personal" ? "Personal" : "Business"} apps`}
      aria-busy={props.loading}
    >
      {props.apps.map((app) => (
        <AppCard
          key={app.id}
          app={app}
          connections={props.connections}
          pending={props.pending}
          error={props.actionErrors[app.id] ?? ""}
          onSelect={props.onSelect}
          onAction={props.onAction}
        />
      ))}
    </section>
  );
}
