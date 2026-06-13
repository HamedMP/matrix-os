import { LayoutGrid, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../../design/primitives";
import { appIconUrl, useApps } from "../../stores/apps";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

function AppIcon({ url, name }: { url: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  const prev = useRef<string | null>(null);
  if (prev.current !== url) {
    prev.current = url;
    if (failed) setFailed(false);
  }
  if (url && !failed) {
    return (
      <img
        src={url}
        alt=""
        className="h-11 w-11 rounded-xl object-cover"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-semibold"
      style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default function AppLauncher() {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const openTab = useTabs((s) => s.openTab);
  const apps = useApps((s) => s.apps);
  const loaded = useApps((s) => s.loaded);
  const load = useApps((s) => s.load);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (api) void load(api);
  }, [api, load]);

  // Launcher behavior: focus the search immediately like a desktop launcher.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q));
  }, [apps, query]);

  // Keep the highlighted index in range as the filter changes.
  useEffect(() => {
    setActive((i) => (i >= filtered.length ? 0 : i));
  }, [filtered.length]);

  const open = (slug: string, name: string) =>
    openTab({ kind: "app", slug, title: name, ...(appIconUrl(platformHost, slug) ? { icon: appIconUrl(platformHost, slug)! } : {}) });

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (filtered.length === 0) return;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (i + 1) % filtered.length);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      setActive((i) => (i - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const app = filtered[active];
      if (app) open(app.slug, app.name);
    }
  };

  if (loaded && apps.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="No apps installed"
        description="Matrix OS apps you install appear here, ready to launch in this window."
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-6 pt-6 pb-3">
        <div
          className="prompt-card flex items-center gap-2 rounded-xl border px-3"
          style={{ background: "var(--bg-surface)" }}
        >
          <Search size={15} style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="h-11 w-full bg-transparent text-md outline-none"
            style={{ color: "var(--text-primary)" }}
          />
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
        {filtered.length === 0 ? (
          <p className="px-1 text-sm" style={{ color: "var(--text-tertiary)" }}>No apps match “{query}”.</p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-3">
            {filtered.map((app, i) => {
              const highlighted = i === active;
              return (
                <button
                  key={app.slug}
                  type="button"
                  className="flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors duration-100"
                  style={{
                    background: highlighted ? "var(--bg-selected)" : "var(--bg-surface)",
                    borderColor: highlighted ? "var(--accent)" : "var(--border-subtle)",
                  }}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => open(app.slug, app.name)}
                >
                  <AppIcon url={appIconUrl(platformHost, app.slug)} name={app.name} />
                  <span className="w-full truncate text-center text-sm" style={{ color: "var(--text-primary)" }}>
                    {app.name}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
