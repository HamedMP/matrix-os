import { useMemo, useState } from "react";
import type { SavedBrowserPage } from "./saved-pages";

export default function BrowserSavedPagesView({
  pages,
  notice,
  onOpen,
  onImport,
}: {
  pages: SavedBrowserPage[];
  notice?: string | null;
  onOpen: (url: string) => void;
  onImport: () => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return pages;
    return pages.filter((page) =>
      `${page.title} ${page.url} ${page.folder}`.toLocaleLowerCase().includes(query));
  }, [pages, search]);
  const visible = filtered.slice(0, 250);

  return (
    <section role="region" aria-label="Saved pages" className="min-h-0 flex-1 overflow-y-auto px-6 py-5" style={{ color: "var(--text-primary)" }}>
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold">Saved pages</h2>
        <button type="button" className="text-sm" style={{ color: "var(--accent)" }} onClick={onImport}>Import from browser</button>
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{pages.length} saved {pages.length === 1 ? "page" : "pages"}</p>
      {notice ? <p role="status" className="mt-3 text-sm">{notice}</p> : null}
      <input
        aria-label="Search saved pages"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search saved pages"
        className="mt-4 h-9 w-full max-w-xl rounded-lg border px-3 text-sm outline-none"
        style={{ background: "var(--bg-app)", borderColor: "var(--border-default)" }}
      />
      <div className="mt-4 max-w-xl space-y-1">
        {visible.map((page) => (
          <button
            type="button"
            key={page.url}
            aria-label={`Open ${page.title}`}
            className="block w-full rounded-lg px-3 py-2 text-left hover:bg-[var(--bg-hover)]"
            onClick={() => onOpen(page.url)}
          >
            <span className="block truncate text-sm font-medium">{page.title}</span>
            <span className="block truncate text-xs" style={{ color: "var(--text-secondary)" }}>{page.folder} · {page.url}</span>
          </button>
        ))}
        {filtered.length > visible.length ? (
          <p className="px-3 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
            Showing the first {visible.length} results. Search to find another page.
          </p>
        ) : null}
        {filtered.length === 0 ? <p className="py-6 text-sm" style={{ color: "var(--text-secondary)" }}>No saved pages found.</p> : null}
      </div>
    </section>
  );
}
