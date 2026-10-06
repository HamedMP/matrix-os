import type { Account, Definition } from "./types";
const labels = {
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
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          {app.name.slice(0, 1)}
        </span>
        <div>
          <strong>{app.name}</strong>
          <span>
            {app.collection === "business"
              ? "Business collection"
              : "Personal collection"}
          </span>
        </div>
      </div>
      <div className="sidebar-label">YOUR WORKSPACE</div>
      <div className="nav-active">
        <span>◈</span>
        {labels[app.view]}
        <span>{count}</span>
      </div>
      <section className="sidebar-filters">
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
      <footer>
        <span className="tiny-dot" />
        Owner-controlled data<p>Private to this Matrix computer</p>
      </footer>
    </aside>
  );
}
