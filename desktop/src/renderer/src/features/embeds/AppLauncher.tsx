import { LayoutGrid } from "lucide-react";
import { useEffect, useState } from "react";
import { EmbedHost } from "./index";
import { EmptyState } from "../../design/primitives";
import { useConnection } from "../../stores/connection";

interface MatrixApp {
  slug: string;
  name: string;
  icon?: string;
  category?: string;
}

function parseApps(value: unknown): MatrixApp[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { apps?: unknown }).apps)
      ? (value as { apps: unknown[] }).apps
      : [];
  const apps: MatrixApp[] = [];
  for (const raw of list.slice(0, 200)) {
    if (!raw || typeof raw !== "object") continue;
    const app = raw as Partial<MatrixApp>;
    if (typeof app.slug !== "string" || app.slug.trim().length === 0) continue;
    const slug = app.slug.trim();
    const name = typeof app.name === "string" && app.name.trim().length > 0 ? app.name.trim() : slug;
    const category =
      typeof app.category === "string" && app.category.trim().length > 0 ? app.category.trim() : undefined;
    apps.push({ slug, name, category });
  }
  return apps;
}

export default function AppLauncher() {
  const api = useConnection((s) => s.api);
  const [apps, setApps] = useState<MatrixApp[] | null>(null);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    api
      .get<unknown>("/api/apps")
      .then((res) => {
        if (!cancelled) setApps(parseApps(res));
      })
      .catch(() => {
        if (!cancelled) setApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  if (activeSlug) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5"
          style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        >
          <button
            type="button"
            className="text-sm hover:underline"
            style={{ color: "var(--accent)" }}
            onClick={() => setActiveSlug(null)}
          >
            ← Apps
          </button>
          <span className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            {apps?.find((a) => a.slug === activeSlug)?.name ?? activeSlug}
          </span>
        </div>
        <EmbedHost kind="app" slug={activeSlug} />
      </div>
    );
  }

  if (apps && apps.length === 0) {
    return (
      <EmptyState
        icon={<LayoutGrid size={26} />}
        headline="No apps installed"
        description="Matrix OS apps you install appear here, ready to launch in this window."
      />
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5">
      <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>
        Apps
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
        {(apps ?? []).map((app) => (
          <button
            key={app.slug}
            type="button"
            className="flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors duration-100 hover:border-[var(--border-strong)]"
            style={{ background: "var(--bg-raised)", borderColor: "var(--border-subtle)" }}
            onClick={() => setActiveSlug(app.slug)}
          >
            <div
              className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-semibold"
              style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
            >
              {app.name.charAt(0).toUpperCase()}
            </div>
            <span className="truncate text-sm" style={{ color: "var(--text-primary)" }}>
              {app.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
