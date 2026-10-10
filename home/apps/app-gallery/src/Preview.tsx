import React, { useState } from "react";
import type { GalleryAppListing } from "./model";
import { previewScreenshots } from "./preview-screenshots";
import { galleryArtwork } from "./artwork";
export function Glyph({ view, size = 24 }: { view: string; size?: number }) {
  const paths: Record<string, string> = {
    finance: "M5 3h14v18H5z M8 7h8 M8 11h3 M8 15h8",
    travel: "M3 17 21 7 14 21 11 14 3 17 M11 14 21 7",
    agenda: "M4 6h16v15H4z M8 3v6 M16 3v6 M4 11h16 M8 15h2 M14 15h2",
    board: "M3 4h5v16H3z M10 4h5v11h-5z M17 4h4v7h-4z",
    library: "M3 5h7l2 2 2-2h7v15h-7l-2 2-2-2H3z M12 7v15",
    notes: "M5 3h14v18H5z M8 7h8 M8 11h8 M8 15h5",
    habits: "M12 21V10 M12 15C3 15 3 7 3 7s9 0 9 8 M12 10c0-8 9-8 9-8s0 8-9 8",
    focus: "M12 3a9 9 0 1 0 9 9 M12 7v5l3 2 M17 3h4v4",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[view] ?? paths.notes} />
    </svg>
  );
}
export function Icon({
  name,
}: {
  name: "search" | "close" | "arrow" | "check" | "refresh" | "grid";
}) {
  const paths = {
    search: "M21 21l-5-5 M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16",
    close: "M6 6l12 12 M18 6 6 18",
    arrow: "M5 12h14 M14 7l5 5-5 5",
    check: "m5 12 4 4 10-10",
    refresh: "M20 7a9 9 0 1 0 1 9 M20 3v5h-5",
    grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

/** Previews never read owner records or invoke an app's bridge. */
export default function Preview({ app, large = false }: { app: GalleryAppListing; large?: boolean }) {
  const [failedScreenshot, setFailedScreenshot] = useState<string | null>(null);
  const screenshotKind = Object.hasOwn(previewScreenshots, app.id) ? previewScreenshots[app.id] : undefined;
  const photographed = screenshotKind !== undefined && failedScreenshot !== app.id;
  const exampleData = photographed && screenshotKind === "example";
  const columns = app.fields.find(field => field.key === "status")?.options?.slice(0, 3) ?? ["Unclassified"];
  const fields = app.fields.filter(field => field.kind !== "longtext").slice(0, 4);
  return (
    <div className={`preview app-identity preview-view-${app.view}${large ? " preview-large" : ""}${photographed ? " preview-photographed" : ""}`} data-app={app.id}
      aria-label={`${photographed ? "Screenshot" : "Layout preview"} of ${app.name}${exampleData ? " with example data" : ", empty workspace"}`} role="img">
      {photographed ? (
        <img key={app.id} className="preview-screenshot" src={galleryArtwork(`previews/${app.id}.png`)} loading="lazy" decoding="async" alt="" onError={() => setFailedScreenshot(app.id)} />
      ) : (
        <div className="preview-window" aria-hidden="true">
          <aside className="preview-rail">
            <strong>{app.name}</strong>
            <div className="preview-nav preview-nav-active">All records</div>
            <div className="preview-nav">Personal</div>
            <div className="preview-nav">Work</div>
            <div className="preview-nav">Connections</div>
          </aside>
          <div className="preview-content">
            <div className="preview-heading"><strong>{app.name}</strong><span className="preview-add">+ Add {app.entity}</span></div>
            {app.view === "finance" && <>
              <div className="preview-ledger"><span>Settled amounts</span><h3>No settled amounts</h3></div>
              <div className="preview-field-headings">{fields.map(field => <span key={field.key}>{field.label}</span>)}</div>
              <div className="preview-empty"><p>Your ledger starts with your first {app.entity}.</p></div>
            </>}
            {app.view === "board" && <div className="preview-board">{columns.map(label => (
              <div className="preview-board-column" key={label}><strong>{label}</strong><p>No {app.entity}s here yet.</p><span>+ Add {app.entity}</span></div>
            ))}</div>}
            {app.view === "notes" && <div className="preview-note"><h3>Your next {app.entity}</h3><p>A blank page for your thoughts.</p><div className="preview-note-rule" /><div className="preview-note-rule" /></div>}
            {app.view === "agenda" && <><div className="preview-calendar">{["M", "T", "W", "T", "F", "S", "S"].map((day, i) => <span key={i}>{day}</span>)}{Array.from({ length: 21 }, (_, i) => <i key={i} />)}</div><div className="preview-empty"><p>No {app.entity}s scheduled.</p></div></>}
            {app.view === "library" && <><div className="preview-library"><div><Glyph view="library" size={24} /></div><div><Glyph view="notes" size={24} /></div></div><div className="preview-empty"><p>Add your first {app.entity}.</p></div></>}
            {app.view === "habits" && <><div className="preview-habits">{Array.from({ length: 21 }, (_, i) => <span key={i} />)}</div><div className="preview-empty"><strong>No check-ins yet</strong><p>Log your first {app.entity} to begin.</p></div></>}
            {app.view === "focus" && <><div className="preview-focus">25:00</div><p className="preview-focus-label">Ready for a focus session</p></>}
            {app.view === "travel" && <><svg className="preview-map" viewBox="0 0 300 170" aria-hidden="true"><path d="m19 35 28-16 30 9 22 25-15 13 4 19-25 20-11-20-20-4Zm70 73 26 1 18 31-19 27-17-24Zm52-64 29-17 31 14 20-10 34 25-13 26-36 1-22-11-29 12-27-22Zm25 41 35 8 11 30-23 33-15-20-9-26Zm70 48 29-3 16 18-24 11-22-10Z" fill="currentColor" opacity=".18" /></svg><p className="preview-travel-label">Your journeys will appear here.</p></>}
          </div>
        </div>
      )}
      <div className="preview-caption">{photographed ? <><span>App screenshot</span><span>{exampleData ? "Example data" : "Empty workspace"}</span></> : <><span>Layout preview</span><span>Starts empty</span></>}</div>
    </div>
  );
}
