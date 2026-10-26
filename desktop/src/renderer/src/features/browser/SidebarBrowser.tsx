import { useState, type FormEvent } from "react";
import { resolveBrowserAddress } from "../../../../shared/runtime-browser-url";
import EmbedHost from "../embeds/EmbedHost";

export default function SidebarBrowser({ active }: { active: boolean }) {
  const [address, setAddress] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const resolved = address.length <= 4096 ? resolveBrowserAddress(address) : null;
    if (!resolved) { setError(true); return; }
    setError(false);
    setUrl(resolved.url);
    setAddress(resolved.url);
    setRefresh((value) => value + 1);
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <form onSubmit={navigate} className="flex gap-2 border-b p-2" style={{ borderColor: "var(--border-subtle)" }}>
      <input aria-label="Website address" placeholder="https://example.com" value={address} onChange={(event) => setAddress(event.target.value)} maxLength={4096} className="min-w-0 flex-1 rounded border bg-transparent px-2 py-1 text-xs" />
      <button type="submit" className="text-xs">Go</button>
      <button type="button" aria-label="Reload website" disabled={!url} onClick={() => setRefresh((value) => value + 1)} className="text-xs disabled:opacity-40">Reload</button>
    </form>
    {error ? <p role="alert" className="p-3 text-xs">Enter an HTTP or HTTPS website address.</p> : null}
    {url ? <EmbedHost kind="browser" url={url} active={active} visible={active} refreshRequest={refresh} />
      : <p className="p-4 text-sm" style={{ color: "var(--text-secondary)" }}>Open a website here. Websites run on this computer; runtime addresses connect to your Matrix computer.</p>}
  </div>;
}
