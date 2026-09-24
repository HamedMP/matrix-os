import { useEffect, useState } from "react";
import { invoke } from "../../lib/operator";

export function useBrowserPasswords(tabId: string, url: string | null, embedId: string | null, onMessage: (message: string) => void) {
  const [accounts, setAccounts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { setAccounts(null); }, [tabId, url]);

  const toggle = async () => {
    if (accounts !== null) { setAccounts(null); return; }
    if (!url || busy) return;
    setBusy(true);
    try {
      const result = await invoke("browser:list-passwords", { origin: new URL(url).origin });
      setAccounts(result.accounts.map((account) => account.username));
    } catch {
      onMessage("Couldn’t open saved passwords.");
    } finally {
      setBusy(false);
    }
  };

  const fill = async (username: string) => {
    if (!embedId || busy) return;
    setBusy(true);
    try {
      const result = await invoke("browser:fill-password", { embedId, username });
      onMessage(result.filled ? "Filled the sign-in form." : "Couldn’t find a sign-in form on this page.");
      if (result.filled) setAccounts(null);
    } catch {
      onMessage("Couldn’t fill this password.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (username: string) => {
    if (!url || busy || !window.confirm(`Remove the imported password for ${username} on this website?`)) return;
    setBusy(true);
    try {
      const result = await invoke("browser:delete-password", { origin: new URL(url).origin, username });
      if (result.deleted) setAccounts((current) => current?.filter((account) => account !== username) ?? null);
      onMessage(result.deleted ? "Removed the imported password." : "This password is no longer saved.");
    } catch {
      onMessage("Couldn’t remove this password.");
    } finally {
      setBusy(false);
    }
  };

  return { accounts, busy, toggle, fill, remove, close: () => setAccounts(null) };
}

export function BrowserPasswordBar({
  accounts, busy, onFill, onRemove, onClose,
}: {
  accounts: string[];
  busy: boolean;
  onFill: (username: string) => void;
  onRemove: (username: string) => void;
  onClose: () => void;
}) {
  return (
    <div role="region" aria-label="Saved passwords for this website" className="flex shrink-0 items-center gap-2 border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)" }}>
      {accounts.length === 0 ? <span>No imported password for this website.</span> : (
        <>
          <span>Fill as</span>
          {accounts.map((username) => (
            <span key={username} className="inline-flex items-center gap-1">
              <button type="button" disabled={busy} className="rounded-lg border px-2 py-1 disabled:opacity-50"
                style={{ borderColor: "var(--border-default)" }} onClick={() => onFill(username)}>{username}</button>
              <button type="button" disabled={busy} aria-label={`Remove password for ${username}`}
                className="rounded px-1 py-1 disabled:opacity-50" onClick={() => onRemove(username)}>Remove</button>
            </span>
          ))}
        </>
      )}
      <button type="button" className="ml-auto" aria-label="Close saved passwords" onClick={onClose}>Close</button>
    </div>
  );
}

export function BrowserPasswordSettings() {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <>
      <div className="rounded-xl border p-4" style={{ borderColor: "var(--border-default)" }}>
        <p className="font-medium">Imported passwords</p>
        <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>Passwords you import are stored in an OS-encrypted local vault. Use Passwords while visiting a site to fill a login form.</p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-xl border p-4" style={{ borderColor: "var(--border-default)" }}>
        <span>
          <span className="block font-medium">Export imported passwords</span>
          <span className="mt-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Save a readable JSON copy to a file you choose. Anyone with access to that file can read the passwords.</span>
        </span>
        <button type="button" className="shrink-0 rounded-lg border px-3 py-2 text-xs" style={{ borderColor: "var(--border-default)" }}
          onClick={() => { void (async () => {
            setNotice(null);
            try {
              const result = await invoke("browser:export-passwords", {});
              if (result.exported) setNotice("Passwords exported to the selected file.");
            } catch {
              setNotice("Couldn’t export passwords. Choose a new filename and try again.");
            }
          })(); }}>Export passwords</button>
      </div>
      {notice ? <p role="status" className="text-xs">{notice}</p> : null}
    </>
  );
}
