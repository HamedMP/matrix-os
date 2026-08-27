import { LayoutGrid, Search } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, EmptyState } from "../../design/primitives";
import { appIconUrl, useApps, type MatrixApp } from "../../stores/apps";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

function AppIcon({ url, name, large = false }: { url: string | null; name: string; large?: boolean }) {
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
        className={`${large ? "h-16 w-16 rounded-[18px]" : "h-11 w-11 rounded-xl"} object-cover shadow-[var(--shadow-1)]`}
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div
      className={`flex items-center justify-center font-semibold shadow-[var(--shadow-1)] ${large ? "h-16 w-16 rounded-[18px] text-xl" : "h-11 w-11 rounded-xl text-lg"}`}
      style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default function AppLauncher({
  presentation = "surface",
  launcherActive = true,
  onLaunch,
}: {
  presentation?: "surface" | "launchpad";
  launcherActive?: boolean;
  onLaunch?: (tabId: string) => void;
} = {}) {
  const api = useConnection((s) => s.api);
  const platformHost = useConnection((s) => s.platformHost);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const openTab = useTabs((s) => s.openTab);
  const apps = useApps((s) => s.apps);
  const loaded = useApps((s) => s.loaded);
  const loading = useApps((s) => s.loading);
  const error = useApps((s) => s.error);
  const load = useApps((s) => s.load);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (api) void load(api);
  }, [api, load]);

  // Launcher behavior: focus the search immediately like a desktop launcher.
  useEffect(() => {
    if (launcherActive) inputRef.current?.focus();
  }, [launcherActive]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter((a) => a.name.toLowerCase().includes(q) || a.slug.toLowerCase().includes(q));
  }, [apps, query]);

  const activeIndex = filtered.length === 0 ? 0 : Math.min(active, filtered.length - 1);

  const open = (app: MatrixApp) => {
    const tabId = openTab({
      kind: "app",
      slug: app.slug,
      title: app.name,
      ...(app.appIdentity ? { appIdentity: app.appIdentity } : {}),
      ...(appIconUrl(platformHost, app.slug, runtimeSlot) ? { icon: appIconUrl(platformHost, app.slug, runtimeSlot)! } : {}),
    });
    onLaunch?.(tabId);
  };

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
      const app = filtered[activeIndex];
      if (app) open(app);
    }
  };

  if (error) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="Apps unavailable"
        description="The app catalog could not be loaded. Try again once your computer is reachable."
        action={
          api ? (
            <Button variant="primary" disabled={loading} onClick={() => void load(api, true)}>
              {loading ? "Loading..." : "Retry"}
            </Button>
          ) : null
        }
      />
    );
  }

  if (loaded && !loading && apps.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="No apps installed"
        description="Matrix OS apps you install appear here, ready to launch in this window."
      />
    );
  }

  if (!loaded && apps.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="Loading apps"
        description="The app catalog will appear here once your computer responds."
      />
    );
  }

  return (
    <div
      data-app-launcher-presentation={presentation}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <div className={`shrink-0 px-6 pb-3 ${presentation === "launchpad" ? "mx-auto w-full max-w-2xl pt-10" : "pt-6"}`}>
        <div
          data-launchpad-interactive={presentation === "launchpad" || undefined}
          className="prompt-card flex items-center gap-2 rounded-xl border px-3 backdrop-blur-2xl"
          style={{
            background: presentation === "launchpad"
              ? "color-mix(in srgb, var(--bg-surface) 72%, transparent)"
              : "var(--bg-surface)",
          }}
        >
          <Search size={15} style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search apps…"
            aria-label="Search apps"
            className="h-11 w-full bg-transparent text-md outline-none"
            style={{ color: "var(--text-primary)", boxShadow: "none", borderRadius: 0 }}
          />
        </div>
      </div>
      <div className={`flex flex-1 flex-col gap-4 overflow-y-auto px-6 pb-24 ${presentation === "launchpad" ? "mx-auto w-full max-w-6xl" : ""}`}>
        {filtered.length === 0 ? (
          <p className="px-1 text-sm" style={{ color: "var(--text-tertiary)" }}>No apps match “{query}”.</p>
        ) : (
          <div className={`grid ${presentation === "launchpad" ? "grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-x-5 gap-y-6" : "grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-3"}`}>
            {filtered.map((app, i) => {
              const highlighted = i === activeIndex;
              return (
                <button
                  key={app.slug}
                  type="button"
                  data-launchpad-interactive={presentation === "launchpad" || undefined}
                  className={`flex flex-col items-center gap-2 rounded-xl transition-colors duration-100 ${presentation === "launchpad" ? "border border-transparent p-3" : "border p-4"}`}
                  style={{
                    background: highlighted
                      ? "color-mix(in srgb, var(--bg-selected) 78%, transparent)"
                      : presentation === "launchpad" ? "transparent" : "var(--bg-surface)",
                    borderColor: highlighted ? "var(--accent)" : presentation === "launchpad" ? "transparent" : "var(--border-subtle)",
                  }}
                  onMouseEnter={() => setActive(i)}
                onClick={() => open(app)}
                >
                  <AppIcon url={appIconUrl(platformHost, app.slug, runtimeSlot)} name={app.name} large={presentation === "launchpad"} />
                  <span
                    className="w-full truncate text-center text-sm font-medium"
                    style={{ color: "var(--text-primary)", textShadow: presentation === "launchpad" ? "0 1px 2px var(--bg-app)" : undefined }}
                  >
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
