import { useEffect, useMemo, useState } from "react";
import { invoke } from "../../lib/operator";

interface Source { id: string; browser: string; profile: string }
interface Site { host: string; passwords: number; cookies: number }
interface OnePasswordItem { id: string; title: string; origin: string }

export default function BrowserSecretImportView() {
  const [sources, setSources] = useState<Source[]>([]);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [items, setItems] = useState<OnePasswordItem[] | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void invoke("browser:list-secret-sources", {}).then((result) => {
      if (current) setSources(result.sources);
    }).catch(() => {
      if (current) setError("Couldn’t find local browser sign-in data.");
    });
    return () => { current = false; };
  }, []);

  const visibleSites = useMemo(() => sites.filter((site) => site.host.includes(filter.trim().toLowerCase())).slice(0, 200), [sites, filter]);

  const preview = async (id: string) => {
    if (busy) return;
    setBusy("preview");
    setError(null);
    setNotice(null);
    setSourceId(id);
    setSites([]);
    setSelectedHosts([]);
    try {
      const result = await invoke("browser:preview-sites", { sourceId: id });
      setSites(result.sites);
    } catch {
      setError("Couldn’t inspect this browser profile. Close the other browser and try again.");
    } finally {
      setBusy(null);
    }
  };

  const importSites = async () => {
    if (!sourceId || selectedHosts.length === 0 || busy) return;
    setBusy("sites");
    setError(null);
    setNotice(null);
    try {
      const result = await invoke("browser:import-sites", { sourceId, hosts: selectedHosts });
      setNotice(`Imported ${result.passwords} ${result.passwords === 1 ? "password" : "passwords"} and ${result.cookies} ${result.cookies === 1 ? "cookie" : "cookies"}.${result.skipped ? ` Couldn’t import ${result.skipped} entries.` : ""}`);
      setSelectedHosts([]);
    } catch {
      setError("Couldn’t import sign-ins. Check the macOS Keychain prompt and try again.");
    } finally {
      setBusy(null);
    }
  };

  const loadOnePassword = async () => {
    if (busy) return;
    setBusy("1password-list");
    setError(null);
    setNotice(null);
    try {
      const result = await invoke("browser:list-1password", {});
      setItems(result.items);
    } catch {
      setError("1Password is unavailable. Open and unlock the 1Password app, enable CLI integration, then try again.");
    } finally {
      setBusy(null);
    }
  };

  const importOnePassword = async () => {
    if (selectedIds.length === 0 || busy) return;
    setBusy("1password-import");
    setError(null);
    setNotice(null);
    try {
      const result = await invoke("browser:import-1password", { ids: selectedIds });
      setNotice(`Imported ${result.imported} ${result.imported === 1 ? "login" : "logins"} from 1Password.${result.skipped ? ` Couldn’t import ${result.skipped} items.` : ""}`);
      setSelectedIds([]);
    } catch {
      setError("Couldn’t import the selected 1Password logins. Unlock 1Password and try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-8 max-w-xl space-y-7 border-t pt-7" style={{ borderColor: "var(--border-default)" }}>
      <section aria-label="Import sign-ins from a local browser">
        <h3 className="text-sm font-semibold">Passwords and signed-in sites</h3>
        <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
          Choose a local Chromium browser profile, then the websites to transfer. macOS may ask you to allow access to that browser’s Safe Storage key. Imported cookies are placed in Matrix Browser only.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {sources.map((source) => (
            <button key={source.id} type="button" disabled={busy !== null}
              aria-pressed={sourceId === source.id}
              className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50"
              style={{ borderColor: sourceId === source.id ? "var(--accent)" : "var(--border-default)" }}
              onClick={() => { void preview(source.id); }}>
              {source.browser} · {source.profile}
            </button>
          ))}
        </div>
        {sources.length === 0 ? <p className="mt-3 text-xs" style={{ color: "var(--text-secondary)" }}>No local Chromium sign-in profiles found on this Mac.</p> : null}
        {sourceId && sites.length > 0 ? (
          <div className="mt-4">
            <label className="block text-xs font-medium" htmlFor="browser-import-site-search">Find a website</label>
            <input id="browser-import-site-search" value={filter} onChange={(event) => setFilter(event.target.value)}
              placeholder="Search websites" className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm"
              style={{ borderColor: "var(--border-default)" }} />
            <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border-default)" }}>
              {visibleSites.map((site) => (
                <label key={site.host} className="flex items-center gap-3 border-b px-3 py-2 text-xs last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
                  <input type="checkbox" checked={selectedHosts.includes(site.host)} onChange={(event) => setSelectedHosts((current) => event.target.checked ? [...current, site.host] : current.filter((host) => host !== site.host))} />
                  <span className="min-w-0 flex-1 truncate">{site.host}</span>
                  <span style={{ color: "var(--text-secondary)" }}>{site.passwords} passwords · {site.cookies} cookies</span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>Select each website you want. Cookies from other sites remain in the source browser.</p>
            <button type="button" disabled={busy !== null || selectedHosts.length === 0}
              className="mt-3 rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
              onClick={() => { void importSites(); }}>
              {busy === "sites" ? "Importing sign-ins…" : `Import selected websites (${selectedHosts.length})`}
            </button>
          </div>
        ) : null}
      </section>

      <section aria-label="Import from 1Password">
        <h3 className="text-sm font-semibold">1Password</h3>
        <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>Use the local 1Password app and CLI to choose Login items. Matrix stores imported passwords in its OS-encrypted browser vault.</p>
        <button type="button" disabled={busy !== null} className="mt-3 rounded-lg border px-3 py-2 text-xs font-medium disabled:opacity-50" style={{ borderColor: "var(--border-default)" }} onClick={() => { void loadOnePassword(); }}>
          {busy === "1password-list" ? "Opening 1Password…" : "Choose 1Password logins"}
        </button>
        {items ? (
          <div className="mt-3">
            {items.length === 0 ? <p className="text-xs">No website Login items found.</p> : (
              <div className="max-h-64 overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border-default)" }}>
                {items.map((item) => (
                  <label key={item.id} className="flex items-center gap-3 border-b px-3 py-2 text-xs last:border-b-0" style={{ borderColor: "var(--border-subtle)" }}>
                    <input type="checkbox" checked={selectedIds.includes(item.id)} onChange={(event) => setSelectedIds((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />
                    <span className="min-w-0 flex-1 truncate">{item.title}</span>
                    <span className="truncate" style={{ color: "var(--text-secondary)" }}>{item.origin}</span>
                  </label>
                ))}
              </div>
            )}
            <button type="button" disabled={busy !== null || selectedIds.length === 0}
              className="mt-3 rounded-lg px-3 py-2 text-xs font-medium disabled:opacity-50"
              style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
              onClick={() => { void importOnePassword(); }}>
              {busy === "1password-import" ? "Importing logins…" : `Import selected logins (${selectedIds.length})`}
            </button>
          </div>
        ) : null}
      </section>
      {notice ? <p role="status" className="text-xs">{notice}</p> : null}
      {error ? <p role="alert" className="text-xs" style={{ color: "var(--status-error, var(--text-primary))" }}>{error}</p> : null}
    </div>
  );
}
