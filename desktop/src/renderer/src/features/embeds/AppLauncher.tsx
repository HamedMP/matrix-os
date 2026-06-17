import { LayoutGrid } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState } from "../../design/primitives";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

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
  const openTab = useTabs((s) => s.openTab);
  const [apps, setApps] = useState<MatrixApp[] | null>(null);

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
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-6">
      <h2 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Apps</h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(124px,1fr))] gap-3">
        {(apps ?? []).map((app) => (
          <button
            key={app.slug}
            type="button"
            className="flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors duration-100 hover:border-[var(--border-strong)]"
            style={{ background: "var(--bg-surface)", borderColor: "var(--border-subtle)" }}
            onClick={() => openTab({ kind: "app", slug: app.slug, title: app.name })}
          >
            <div
              className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-semibold"
              style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
            >
              {app.name.charAt(0).toUpperCase()}
            </div>
            <span className="w-full truncate text-center text-sm" style={{ color: "var(--text-primary)" }}>
              {app.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
