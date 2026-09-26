import { useEffect, useState } from "react";
import { invoke } from "../../lib/operator";
import type { SavedBrowserPage } from "./saved-pages";

interface Source {
  id: string;
  browser: string;
  profile: string;
  pageCount: number;
}

export default function BrowserImportView({
  onBack,
  onImported,
}: {
  onBack: () => void;
  onImported: (pages: SavedBrowserPage[]) => void;
}) {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void invoke("browser:list-import-sources", {}).then((result) => {
      if (current) setSources(result.sources);
    }).catch(() => {
      if (current) setError("Couldn’t find local browser profiles. Try again later.");
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, []);

  const importSource = async (sourceId: string) => {
    if (busy) return;
    setBusy(sourceId);
    setError(null);
    try {
      const result = await invoke("browser:import-pages", { sourceId });
      onImported(result.pages);
    } catch {
      setError("Couldn’t import these pages. Your other browser’s data is unchanged.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section role="region" aria-label="Import browser data" className="min-h-0 flex-1 overflow-y-auto px-6 py-5" style={{ color: "var(--text-primary)" }}>
      <button type="button" className="mb-4 text-sm" style={{ color: "var(--accent)" }} onClick={onBack}>← Browser settings</button>
      <h2 className="text-base font-semibold">Import from another browser</h2>
      <p className="mt-2 max-w-xl text-sm" style={{ color: "var(--text-secondary)" }}>
        Bring your saved pages into Matrix Browser. Sign-ins, passwords, and extensions stay in your other browser.
      </p>
      {loading ? <p role="status" className="mt-6 text-sm">Finding local browsers…</p> : null}
      {!loading && sources.length === 0 && !error ? (
        <p role="status" className="mt-6 text-sm">No supported local browser profiles with saved pages were found. Local import is currently available on macOS.</p>
      ) : null}
      {error ? <p role="alert" className="mt-6 text-sm" style={{ color: "var(--status-error, var(--text-primary))" }}>{error}</p> : null}
      <div className="mt-5 max-w-xl space-y-3">
        {sources.map((source) => {
          const label = `Import ${source.pageCount} ${source.pageCount === 1 ? "page" : "pages"} from ${source.browser} ${source.profile}`;
          return (
            <div key={source.id} className="flex items-center justify-between gap-4 rounded-xl border p-4" style={{ borderColor: "var(--border-default)" }}>
              <div>
                <p className="font-medium">{source.browser} · {source.profile}</p>
                <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{source.pageCount} saved {source.pageCount === 1 ? "page" : "pages"}</p>
              </div>
              <button
                type="button"
                aria-label={label}
                disabled={busy !== null}
                className="rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50"
                style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
                onClick={() => { void importSource(source.id); }}
              >
                {busy === source.id ? "Importing…" : "Import"}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
