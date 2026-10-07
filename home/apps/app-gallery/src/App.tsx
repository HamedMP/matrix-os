import { useCallback, useEffect, useRef, useState } from "react";
import {
  deriveGalleryReadiness,
  visibleApps,
  loadGallery,
  installGalleryApp,
  openGalleryApp,
  type GalleryBridge,
  type GalleryAppListing,
  type GalleryConnection,
  type GalleryFilters,
  type GalleryReadinessStatus,
} from "./model";
import Preview, { Glyph, Icon } from "./Preview";
import GalleryResults from "./GalleryResults";
declare global {
  interface Window {
    MatrixOS?: GalleryBridge;
  }
}
const statusLabels: Record<GalleryReadinessStatus, string> = {
  ready: "Connections ready",
  choose_accounts: "Choose accounts after install",
  needs_connection: "Connection needed",
  unknown: "Connections not checked",
};
function Detail({
  app,
  connections,
  pending,
  error,
  onClose,
  onAction,
}: {
  app: GalleryAppListing;
  connections: GalleryConnection[] | null;
  pending: boolean;
  error: string;
  onClose: () => void;
  onAction: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const readiness = deriveGalleryReadiness(app, connections);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="detail"
      aria-labelledby="detail-title"
      onCancel={onClose}
    >
      <div className="detail-inner">
        <header className="detail-header">
          <div className="app-symbol">
            <Glyph view={app.view} size={30} />
          </div>
          <div>
            <p>
              {app.collection === "personal" ? "Personal" : "Business"} /{" "}
              {app.category}
            </p>
            <h2 id="detail-title">{app.name}</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close app details"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </header>
        <Preview app={app} large />
        <div className="detail-body">
          <h3>{app.tagline}</h3>
          <p className="description">{app.description}</p>
          <ul className="highlights">
            {app.highlights.map((value) => (
              <li key={value}>
                <Icon name="check" />
                {value}
              </li>
            ))}
          </ul>
          <section className="requirements">
            <h3>Your connections</h3>
            <p className="muted">
              {app.services.length
                ? "Select accounts in the app when you ask Matrix to import."
                : "This app works with your own entries. No external connection required."}
            </p>
            {readiness.services.map((service) => (
              <div className="requirement" key={service.id}>
                <span className="service-symbol">
                  <Icon name="grid" />
                </span>
                <div>
                  <strong>{service.name}{app.services.find(source => source.id === service.id)?.optional ? " · optional source" : ""}</strong>
                  <p>
                    {connections === null
                      ? "Connection inventory unavailable"
                      : service.accounts.length
                        ? service.accounts
                            .map(
                              (account) =>
                                account.account_label +
                                (account.account_email
                                  ? ` (${account.account_email})`
                                  : ""),
                            )
                            .join(", ")
                        : "No connected account"}
                  </p>
                </div>
                <span
                  className={`connection-state ${service.accounts.length ? "available" : ""}`}
                >
                  {connections === null
                    ? "Unknown"
                    : service.accounts.length
                      ? `${service.accounts.length} ${service.accounts.length === 1 ? "account" : "accounts"}`
                      : "Needed"}
                </span>
              </div>
            ))}
          </section>
          <p className="owner-note">
            Installed apps start empty. Your records stay in your own Matrix
            database.{" "}
            {app.collection === "business"
              ? "Business is a collection on your computer. "
              : ""}
            Imports happen only when you ask Matrix.
          </p>
        </div>
        <footer className="detail-footer">
          <div aria-live="polite">
            {error ? (
              <span className="error-text">{error}</span>
            ) : (
              <span className="muted">
                {app.installed
                  ? "Already on your computer"
                  : statusLabels[readiness.status]}
              </span>
            )}
          </div>
          <button
            className="primary-button"
            onClick={onAction}
            disabled={pending}
          >
            {pending
              ? "Installing…"
              : app.installed
                ? "Open app"
                : error
                  ? "Retry installation"
                  : "Install app"}
            <Icon name="arrow" />
          </button>
        </footer>
      </div>
    </dialog>
  );
}
export default function App() {
  const [apps, setApps] = useState<GalleryAppListing[]>([]),
    [connections, setConnections] = useState<GalleryConnection[] | null>(null),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(""),
    [selected, setSelected] = useState<string | null>(null),
    [pending, setPending] = useState<string | null>(null),
    [actionErrors, setActionErrors] = useState<Record<string, string>>({}),
    [notice, setNotice] = useState("");
  const [filters, setFilters] = useState<GalleryFilters>({
    collection: "personal",
    query: "",
    category: "",
    readiness: "all",
  });
  const request = useRef(0),
    busy = useRef(false);
  const refresh = useCallback(async () => {
    const version = ++request.current;
    setLoading(true);
    setLoadError("");
    try {
      if (!window.MatrixOS) throw new Error("Gallery unavailable");
      const result = await loadGallery(window.MatrixOS);
      if (version === request.current) {
        setApps(result.apps);
        setConnections(result.connections);
      }
    } catch (error) {
      console.warn(
        "App gallery could not load",
        error instanceof Error ? error.name : "Unknown error",
      );
      if (version === request.current)
        setLoadError(
          window.MatrixOS
            ? "The gallery could not load. Try again."
            : "Open App Gallery in Web Desktop, Web Canvas or Electron Desktop.",
        );
    } finally {
      setLoading(current => version === request.current ? false : current);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => {
      request.current++;
    };
  }, [refresh]);
  const action = async (app: GalleryAppListing) => {
    if (busy.current) return;
    busy.current = true;
    setNotice("");
    setActionErrors((errors) => ({ ...errors, [app.id]: "" }));
    try {
      if (!window.MatrixOS) throw new Error("App unavailable");
      if (app.installed) {
        await openGalleryApp(window.MatrixOS, app);
      } else {
        setPending(app.id);
        const result = await installGalleryApp(window.MatrixOS, app.id);
        // Discovery started before this install may still contain its old state.
        request.current++;
        setLoading(false);
        setLoadError("");
        setApps((items) =>
          items.map((item) =>
            item.id === app.id
              ? {
                  ...item,
                  installed: true,
                  installedName: result.name,
                  launchPath: result.path,
                }
              : item,
          ),
        );
        setNotice(`${result.name} is ready to open.`);
      }
    } catch (error) {
      console.warn(
        "Gallery action unavailable",
        error instanceof Error ? error.name : "Unknown error",
      );
      setActionErrors((errors) => ({
        ...errors,
        [app.id]: app.installed
          ? "The app could not open. Try again."
          : "Installation did not finish. Try again.",
      }));
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  const visible = visibleApps(apps, filters, connections),
    active = apps.find((app) => app.id === selected);
  const categories = [
    ...new Set(
      apps
        .filter((app) => app.collection === filters.collection)
        .map((app) => app.category),
    ),
  ].sort();
  const chooseCollection = (collection: "personal" | "business") =>
    setFilters((current) => ({
      ...current,
      collection,
      category: "",
      query: "",
      readiness: "all",
    }));
  return (
    <main className="gallery">
      <header className="gallery-header">
        <div className="gallery-brand">
          <span className="gallery-logo">
            <Icon name="grid" />
          </span>
          <span>App Gallery</span>
        </div>
        <button
          className="icon-button"
          aria-label="Refresh gallery and connections"
          onClick={() => void refresh()}
          disabled={loading || pending !== null}
        >
          <Icon name="refresh" />
        </button>
      </header>
      <div className="gallery-content">
        <section className="heading">
          <div>
            <h1>Good tools. More possibilities.</h1>
            <p>Thoughtfully designed apps for your life and work.</p>
          </div>
          <div
            className="collections"
            role="tablist"
            aria-label="App collections"
          >
            {(["personal", "business"] as const).map((collection) => (
              <button
                role="tab"
                aria-selected={filters.collection === collection}
                tabIndex={filters.collection === collection ? 0 : -1}
                key={collection}
                onClick={() => chooseCollection(collection)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                    event.preventDefault();
                    chooseCollection(
                      collection === "personal" ? "business" : "personal",
                    );
                    const sibling =
                      event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(
                        `button[aria-selected="false"]`,
                      );
                    sibling?.focus();
                  }
                }}
              >
                {collection === "personal" ? "Personal" : "Business"}
                <span>
                  {apps.filter((app) => app.collection === collection).length ||
                    "—"}
                </span>
              </button>
            ))}
          </div>
        </section>
        <div className="filters">
          <label className="search">
            <Icon name="search" />
            <input
              aria-label="Search apps"
              maxLength={200}
              value={filters.query}
              placeholder="Find your next useful app"
              onChange={(event) =>
                setFilters((current) => ({
                  ...current,
                  query: event.target.value,
                }))
              }
            />
          </label>
          <select
            aria-label="Category"
            value={filters.category}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                category: event.target.value,
              }))
            }
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category}>{category}</option>
            ))}
          </select>
          <select
            aria-label="Connection readiness"
            value={filters.readiness}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                readiness: event.target.value as GalleryFilters["readiness"],
              }))
            }
          >
            <option value="all">All connections</option>
            <option value="ready">Connections ready</option>
            <option value="choose_accounts">Choose accounts</option>
            <option value="needs_connection">Connection needed</option>
            <option value="unknown">Not checked</option>
            <option value="installed">Installed</option>
          </select>
        </div>
        <div className="collection-description">
          <span>
            {filters.collection === "personal"
              ? "Make everyday life feel a little more organized."
              : "A focused workspace for the way you do business."}
          </span>
          <span>
            {!loading &&
              `${visible.length} ${visible.length === 1 ? "app" : "apps"}`}
          </span>
        </div>
        {notice && (
          <div className="notice" role="status">
            <Icon name="check" />
            {notice}
          </div>
        )}
        {connections === null && !loading && !loadError && (
          <p className="inventory-note">
            Connections could not be checked. You can still explore and install
            apps.
          </p>
        )}
        <GalleryResults
          apps={visible}
          connections={connections}
          loading={loading}
          error={loadError}
          collection={filters.collection}
          bridgeUnavailable={!window.MatrixOS}
          pending={pending}
          actionErrors={actionErrors}
          onSelect={setSelected}
          onAction={action}
          onRefresh={refresh}
          onClear={() =>
            setFilters((current) => ({
              ...current,
              query: "",
              category: "",
              readiness: "all",
            }))
          }
        />
        <footer className="gallery-footer">
          <span>Built for your own computer.</span>
          <span>Preview illustrations contain no personal data.</span>
        </footer>
      </div>
      {active && (
        <Detail
          app={active}
          connections={connections}
          pending={pending !== null}
          error={actionErrors[active.id] ?? ""}
          onClose={() => setSelected(null)}
          onAction={() => void action(active)}
        />
      )}
    </main>
  );
}
