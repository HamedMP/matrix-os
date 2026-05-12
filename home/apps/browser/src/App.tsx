import { useEffect, useRef, useState } from "react";
import { BrowserToolbar } from "./BrowserToolbar";
import { BrowserViewport } from "./BrowserViewport";
import { useBrowserSession } from "./useBrowserSession";

interface BrowserGrantItem {
  id: string;
  scopes: string[];
  domains: string[];
}

interface BrowserDownloadItem {
  id: string;
  filename: string;
  state: string;
}

export default function App() {
  const browser = useBrowserSession();
  const [muted, setMuted] = useState(true);
  const [downloads, setDownloads] = useState<BrowserDownloadItem[]>([]);
  const [grants, setGrants] = useState<BrowserGrantItem[]>([]);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const bootedFromRoute = useRef(false);

  async function refreshOwnerData() {
    const [downloadsRes, grantsRes] = await Promise.all([
      fetch("/api/browser/downloads"),
      fetch("/api/browser/grants"),
    ]);
    if (downloadsRes.ok) {
      const body = await downloadsRes.json() as { downloads?: BrowserDownloadItem[] };
      setDownloads(body.downloads ?? []);
    }
    if (grantsRes.ok) {
      const body = await grantsRes.json() as { grants?: BrowserGrantItem[] };
      setGrants(body.grants ?? []);
    }
  }

  async function clearBrowserData() {
    setSettingsMessage(null);
    const res = await fetch("/api/browser/profiles/default/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scopes: ["cookies", "localStorage", "cache", "savedPasswords", "downloads"] }),
    });
    setSettingsMessage(res.ok ? "Browser data cleared" : "Browser request is invalid.");
    if (res.ok) await refreshOwnerData();
  }

  async function revokeGrant(id: string) {
    await fetch(`/api/browser/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshOwnerData();
  }

  async function grantAgentAccess() {
    setSettingsMessage(null);
    if (!browser.session) {
      setSettingsMessage("Open a Browser session first.");
      return;
    }
    const domain = safeHostname(browser.url);
    if (!domain) {
      setSettingsMessage("Browser request is invalid.");
      return;
    }
    const res = await fetch("/api/browser/grants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: browser.session.session.id,
        scopes: ["read_dom", "screenshot"],
        domains: [domain],
      }),
    });
    setSettingsMessage(res.ok ? "Agent access granted" : "Browser request is invalid.");
    if (res.ok) await refreshOwnerData();
  }

  async function deleteDownload(id: string) {
    await fetch(`/api/browser/downloads/${encodeURIComponent(id)}`, { method: "DELETE" });
    await refreshOwnerData();
  }

  useEffect(() => {
    if (bootedFromRoute.current || typeof window === "undefined") return;
    bootedFromRoute.current = true;
    const params = new URLSearchParams(window.location.search);
    const target = params.get("target");
    if (!target) return;
    const surface = params.get("surface") === "standalone" ? "standalone" : "canvas";
    void browser.navigate(target, surface, params.get("handoff") ?? undefined);
  }, [browser]);

  useEffect(() => {
    void refreshOwnerData().catch((err: unknown) => {
      console.warn("[browser-app] Failed to load Browser owner data:", err instanceof Error ? err.message : String(err));
    });
  }, []);

  return (
    <main className="browser-app" data-state={browser.state}>
      <BrowserToolbar
        url={browser.url}
        muted={muted}
        busy={browser.state === "starting"}
        downloads={downloads}
        onNavigate={browser.navigate}
        onToggleMute={() => setMuted((value) => !value)}
        onDeleteDownload={deleteDownload}
      />
      <section className="browser-owner-panel" aria-label="Browser data">
        <button type="button" onClick={clearBrowserData}>Clear browser data</button>
        <button type="button" onClick={grantAgentAccess}>Grant agent access</button>
        <span>{downloads.length} downloads</span>
        <span>{grants.length} active grants</span>
        {grants.map((grant) => (
          <button key={grant.id} type="button" onClick={() => revokeGrant(grant.id)}>
            Revoke {grant.scopes.join(", ")}
          </button>
        ))}
        {settingsMessage ? <span role="status">{settingsMessage}</span> : null}
      </section>
      <BrowserViewport
        state={browser.state}
        error={browser.error}
        url={browser.url}
        onTakeover={browser.takeover}
        onFocusSurface={() => browser.sendStreamMessage({
          type: "surface.focus",
          payload: { surfaceId: browser.surfaceId, reason: "programmatic" },
        })}
        onPointerInput={(input) => browser.sendStreamMessage({
          type: "input.pointer",
          payload: { ...input, modifiers: [] },
        })}
        onKeyboardInput={(input) => browser.sendStreamMessage({
          type: "input.keyboard",
          payload: { ...input, modifiers: [] },
        })}
        onPasteInput={(text) => browser.sendStreamMessage({
          type: "input.paste",
          payload: { text },
        })}
        onImeInput={(kind, text) => browser.sendStreamMessage({
          type: "input.ime",
          payload: { kind, text },
        })}
      />
    </main>
  );
}

function safeHostname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.hostname || null;
  } catch (err: unknown) {
    console.warn("[browser-app] Invalid grant host:", err instanceof Error ? err.message : String(err));
    return null;
  }
}
