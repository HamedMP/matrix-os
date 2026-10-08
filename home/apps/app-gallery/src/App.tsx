import { galleryArtwork } from "./artwork";
import React, { useCallback, useEffect, useRef, useState } from "react";
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
} from "./model";
import { Icon } from "./Preview";
import AppIdentity from "./AppIdentity";
import GalleryResults from "./GalleryResults";
import GalleryDetail from "./GalleryDetail";
import { requestAppBuild } from "./build-handoff";
declare global {
  interface Window {
    MatrixOS?: GalleryBridge;
  }
}
export default function App() {
  const [buildPrompt, setBuildPrompt] = useState("");
  const [building, setBuilding] = useState(false);
  const buildBusy = useRef(false);
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
  const browseScroll = useRef(0);
  const lastSelected = useRef<string | null>(null);
  const lastTrigger = useRef("card-preview");
  const galleryRef = useRef<HTMLElement>(null);
  const chooseApp = (id: string, trigger = "card-preview") => { lastTrigger.current = trigger; browseScroll.current = galleryRef.current?.scrollTop ?? 0; lastSelected.current = id; setSelected(id); };
  useEffect(() => {
    if (selected) { if (galleryRef.current) galleryRef.current.scrollTop = 0; return; }
    if (lastSelected.current) {
      const button = galleryRef.current?.querySelector<HTMLButtonElement>(`article[aria-labelledby="gallery-title-${lastSelected.current}"] .${lastTrigger.current}`);
      button?.focus({ preventScroll: true });
      if (galleryRef.current) galleryRef.current.scrollTop = browseScroll.current;
    }
  }, [selected]);
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
  const build = async (input = buildPrompt) => {
    if (buildBusy.current) return;
    buildBusy.current = true;
    setBuildPrompt(input);
    setBuilding(true);
    setNotice("");
    try {
      await requestAppBuild(window.MatrixOS ?? {}, input);
      // Legacy generate is fire-and-forget in both hosts, not a delivery receipt.
      // Keep the draft so disconnection or an expired host queue cannot lose it.
      setNotice("Build requested. Check Chat for delivery. Your prompt is kept here.");
    } catch (error) {
      console.warn("App build handoff unavailable", error instanceof Error ? error.name : "Unknown error");
      setNotice("The build request could not be sent. Try again in Chat.");
    } finally { buildBusy.current = false; setBuilding(false); }
  };
  const installed = apps.filter(app => app.installed && app.collection === filters.collection);
  const control = (name: string) => <img src={galleryArtwork(`controls/${name}.svg`)} alt="" aria-hidden="true" />;
  return (
    <main className="gallery" ref={galleryRef}>
      {active ? <GalleryDetail app={active} connections={connections} pending={pending !== null}
        error={actionErrors[active.id] ?? ""} onClose={() => setSelected(null)} onAction={() => void action(active)} /> : (
      <div className="gallery-content">
        <header className="gallery-heading">
          <h1>Apps</h1>
          <div className="heading-tools">
            <label className="search">{control("search")}<input aria-label="Search apps" maxLength={200} value={filters.query} placeholder="Search"
              onChange={event => setFilters(current => ({ ...current, query: event.target.value }))} /></label>
            <button className="icon-button refresh" aria-label="Refresh gallery and connections" onClick={() => void refresh()} disabled={loading || pending !== null}><Icon name="refresh" /></button>
          </div>
        </header>
        <section className="build-composer" aria-labelledby="build-title">
          <h2 id="build-title">{control("sparkles")}What should we make?</h2>
          <form onSubmit={event => { event.preventDefault(); void build(); }}>
            <textarea aria-label="Describe an app" placeholder="Describe an app…" maxLength={2000} value={buildPrompt} disabled={building}
              onChange={event => setBuildPrompt(event.target.value)} rows={1} />
            <div className="build-bottom">
              <div className="build-suggestions">{["Subscriptions", "Weekly plan", "Workout log"].map(idea => <button type="button" key={idea} onClick={() => setBuildPrompt(idea)}>{idea}</button>)}</div>
              <button className="build-submit" type="submit" aria-label="Build app" disabled={building || !buildPrompt.trim() || !window.MatrixOS?.generate}>{control("arrow-up")}</button>
            </div>
          </form>
          {!window.MatrixOS?.generate && <p className="build-unavailable">Open Chat to describe an app you’d like to build.</p>}
        </section>
        {notice && <p className="notice" role="status">{notice}</p>}
        <section className="your-apps" aria-labelledby="your-apps-title">
          <div className="section-heading"><h2 id="your-apps-title">Your apps</h2>
            <div className="collections" role="tablist" aria-label="App collections">
              {(["personal", "business"] as const).map(collection => <button role="tab" key={collection} aria-selected={filters.collection === collection}
                tabIndex={filters.collection === collection ? 0 : -1} onClick={() => chooseCollection(collection)}
                onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); chooseCollection(collection === "personal" ? "business" : "personal"); event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('button[aria-selected="false"]')?.focus(); } }}>
                {collection === "personal" ? "Personal" : "Business"}</button>)}
            </div>
          </div>
          {installed.length ? <div className="installed-strip">{installed.map(app => <button key={app.id} disabled={pending !== null} aria-label={`Launch ${app.name}`} onClick={() => void action(app)}><AppIdentity app={app} /><span>{app.installedName ?? app.name}</span></button>)}</div>
            : <p className="installed-empty">{loading ? "Loading your apps…" : "Your installed apps will appear here."}</p>}
          {installed.filter(app => actionErrors[app.id] && !visible.some(item => item.id === app.id)).map(app =>
            <p className="card-error" role="alert" key={app.id}>{actionErrors[app.id]}</p>)}
        </section>
        <section className="catalog-section" aria-labelledby="catalog-title">
          <div className="section-heading"><h2 id="catalog-title">Gallery</h2>
            <nav className="category-tabs" aria-label="App categories">
              {["", ...categories].map(category => <button key={category} aria-pressed={filters.category === category} onClick={() => setFilters(current => ({...current, category}))}>{category || "All"}</button>)}
            </nav>
          </div>
          <div className="readiness-tools"><select aria-label="Connection readiness" value={filters.readiness}
            onChange={event => setFilters(current => ({...current, readiness: event.target.value as GalleryFilters["readiness"]}))}>
            <option value="all">All connections</option><option value="ready">Connections ready</option><option value="choose_accounts">Choose accounts</option><option value="needs_connection">Connection needed</option><option value="unknown">Not checked</option><option value="installed">Installed</option>
          </select><span>{!loading && `${visible.length} ${visible.length === 1 ? "app" : "apps"}`}</span></div>
          <GalleryResults apps={visible} connections={connections} loading={loading} error={loadError} collection={filters.collection}
            bridgeUnavailable={!window.MatrixOS} pending={pending} actionErrors={actionErrors} onSelect={chooseApp} onAction={action} onRefresh={refresh}
            onClear={() => setFilters(current => ({...current, query: "", category: "", readiness: "all"}))} />
        </section>
        <section className="ideas" aria-labelledby="ideas-title"><h2 id="ideas-title">Ideas</h2><div className="ideas-grid">
          {["Who should I reconnect with this week?", "Tell me when my wishlist items are worth buying", "Compare the flats I’m viewing"].map(idea => <button key={idea} disabled={building || !window.MatrixOS?.generate} onClick={() => void build(idea)}><span>“{idea}”</span><small>{control("sparkles")}Build this</small></button>)}
        </div></section>
        <footer className="gallery-footer"><span>Made for your Matrix computer.</span><span>Real app previews. Example data is labelled. Apps start empty.</span></footer>
      </div>)}
    </main>
  );
}
