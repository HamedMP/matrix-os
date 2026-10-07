import { useState } from "react";
import type { Account, Definition } from "./types";
const workflowMarks = ["workout-coach","paycheck-runway","meal-planner","job-search","study-notes","journal-memory","chess-coach","people","cashflow"];
const workflowArtwork = new URL("../public/matrix-workflow-objects-v1.webp",import.meta.url).href;
const labels: Record<string, string> = {
  finance: "Overview & ledger",
  board: "Workspace board",
  agenda: "Your agenda",
  travel: "Your journeys",
  focus: "Focus sessions",
  habits: "Habit check-ins",
  notes: "Notebook",
  library: "Library",
};
interface Props {
  app: Definition;
  count: number | null;
  canUseRecords: boolean;
  canImport: boolean;
  accounts: Account[];
  query: string;
  setQuery: (value: string) => void;
  scope: "all" | "personal" | "work";
  setScope: (value: "all" | "personal" | "work") => void;
  account: string;
  setAccount: (value: string) => void;
  onImport: () => void;
  onAdd: () => void;
}
export default function Sidebar({
  app,
  count,
  canUseRecords,
  canImport,
  accounts,
  query,
  setQuery,
  scope,
  setScope,
  account,
  setAccount,
  onImport,
  onAdd,
}: Props) {
  const markIndex = workflowMarks.indexOf(app.id);
  const [controlsOpen, setControlsOpen] = useState(() => !canUseRecords || !!(query || scope !== "all" || account));
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className={`brand-mark ${markIndex >= 0 ? "sculptural-mark" : ""}`} aria-hidden="true" style={markIndex >= 0 ? { backgroundImage: `url(${workflowArtwork})`, backgroundSize: "300% 300%", backgroundPosition: `${(markIndex % 3) * 50}% ${Math.floor(markIndex / 3) * 50}%` } : undefined}>
          {markIndex < 0 && <svg viewBox="0 0 32 32" fill="none"><path d={markPath(app.id,app.view)} stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round"/><circle cx="25" cy="7" r="4" fill="currentColor" opacity=".18"/></svg>}
        </span>
        <div>
          <strong>{app.name}</strong>
          <span>
            {app.collection === "business"
              ? "Work collection"
              : "Personal collection"}
          </span>
        </div>
      </div>

      <div className="nav-active">
        <span>◈</span>
        {labels[app.view] || "Your workspace"}
        <span>{count}</span>
      </div>
      <details className="workspace-controls" open={controlsOpen} onToggle={(event) => setControlsOpen(event.currentTarget.open)}><summary>Filters &amp; connections</summary><section className="sidebar-filters">
        <label>
          <span>Search records</span>
          <input
            aria-label="Search records"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={`Find a ${app.entity}…`}
          />
        </label>
        <label>
          <span>Record group</span>
          <select
            aria-label="Record group filter"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="all">All records</option>
            <option value="personal">Personal</option>
            <option value="work">Work</option>
          </select>
        </label>
        {accounts.length > 0 && (
          <label>
            <span>Source account</span>
            <select
              aria-label="Source account filter"
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            >
              <option value="">All source accounts</option>
              {accounts.map((a) => (
                <option
                  key={`${a.service}:${a.label}`}
                  value={`${a.service}:${a.label}`}
                >
                  {a.email ?? a.label} · {a.service}
                </option>
              ))}
            </select>
          </label>
        )}
        {(query || scope !== "all" || account) && (
          <button
            onClick={() => {
              setQuery("");
              setScope("all");
              setAccount("");
            }}
          >
            Clear filters
          </button>
        )}
      </section>
      <div className="connection-card">
        <span className="orb" aria-hidden="true">
          ↗
        </span>
        <h3>
          {app.services.length
            ? "Bring in your context."
            : "Make this space yours."}
        </h3>
        <p>
          {app.services.length
            ? "Choose accounts and ask Matrix to gather supported records."
            : "Add your own records. Every entry stays on your computer."}
        </p>
        <button
          disabled={app.services.length ? !canImport : !canUseRecords}
          onClick={() => (app.services.length ? onImport() : onAdd())}
        >
          {app.services.length ? "Connect & import" : `Add ${app.entity}`}
        </button>
      </div>
      </details>
      <footer>
        <span className="tiny-dot" />
        Owner-controlled data<p>Private to this Matrix computer</p>
      </footer>
    </aside>
  );
}

function markPath(id: string, view: string): string {
 if (["atlas"].includes(id)) return "M16 4a12 12 0 1 0 0 24 12 12 0 0 0 0-24ZM4 16h24M16 4c-7 7-7 17 0 24 7-7 7-17 0-24Z";
 if (["people","hiring","support"].includes(id)) return "M16 5a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM6 27v-3a10 10 0 0 1 20 0v3";
 if (id === "subscriptions") return "M7 12a10 10 0 0 1 18-3M25 9V4M25 9h-5M25 20a10 10 0 0 1-18 3M7 23v5M7 23h5";
 if (id === "focus") return "M9 5h14M9 27h14M10 5c0 7 12 15 12 22M22 5c0 7-12 15-12 22";
 if (view === "agenda") return "M6 8h20v19H6ZM10 4v7M22 4v7M6 14h20M11 19h3M19 19h3M11 23h3";
 if (view === "board") return "M5 7h6v18H5ZM13 7h6v13h-6ZM21 7h6v16h-6Z";
 if (view === "finance") return "M6 6h20v21H6ZM11 20v-4M16 20v-8M21 20v-6M10 9h12";
 if (["notes","library"].includes(view)) return "M16 8c-4-4-8-4-12-2v19c4-2 8-2 12 2 4-4 8-4 12-2V6c-4-2-8-2-12 2ZM16 8v19";
 return "M8 4h16l4 12-12 12L4 16 8 4ZM8 4l8 12 8-12M4 16h24M16 16v12";
}
