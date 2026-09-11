import { ExternalLink, Globe2, Plus, SlidersHorizontalIcon, X } from "@renderer/lib/hugeicons";
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { resolveBrowserAddress } from "../../../../shared/runtime-browser-url";
import { invoke } from "../../lib/operator";
import { useBrowserNavigation } from "../../stores/browser-navigation";
import EmbedHost from "../embeds/EmbedHost";

const BROWSER_SESSION_KEY = "matrix.desktop.browser.session.v1";
const BROWSER_SETTINGS_KEY = "matrix.desktop.browser.settings.v1";
const MAX_BROWSER_TABS = 8;

interface BrowserPage {
  id: string;
  address: string;
  url: string | null;
  navigationRevision: number;
}

interface BrowserSession {
  tabs: BrowserPage[];
  activeId: string;
}

let nextBrowserTab = 0;

function createBrowserPage(): BrowserPage {
  nextBrowserTab += 1;
  return {
    id: `browser-tab-${Date.now().toString(36)}-${nextBrowserTab}`,
    address: "",
    url: null,
    navigationRevision: 0,
  };
}

function restorePreviousTabsEnabled(): boolean {
  try {
    const stored = window.localStorage.getItem(BROWSER_SETTINGS_KEY);
    if (!stored) return true;
    return JSON.parse(stored)?.restorePreviousTabs !== false;
  } catch {
    return true;
  }
}

function readBrowserSession(): BrowserSession {
  const fallback = createBrowserPage();
  if (!restorePreviousTabsEnabled()) return { tabs: [fallback], activeId: fallback.id };
  try {
    const stored = window.localStorage.getItem(BROWSER_SESSION_KEY);
    if (!stored) return { tabs: [fallback], activeId: fallback.id };
    const parsed = JSON.parse(stored) as Partial<BrowserSession>;
    if (!Array.isArray(parsed.tabs)) return { tabs: [fallback], activeId: fallback.id };
    const tabs = parsed.tabs.slice(0, MAX_BROWSER_TABS).flatMap<BrowserPage>((candidate): BrowserPage[] => {
      if (!candidate || typeof candidate !== "object") return [];
      const page = candidate as Partial<BrowserPage>;
      if (typeof page.id !== "string" || page.id.length > 100) return [];
      if (page.url === null && (page.address === "" || page.address === undefined)) {
        return [{ id: page.id, address: "", url: null, navigationRevision: 0 }];
      }
      if (typeof page.url !== "string") return [];
      const resolved = resolveBrowserAddress(page.url);
      if (!resolved || resolved.url !== page.url) return [];
      return [{
        id: page.id,
        address: typeof page.address === "string" ? page.address.slice(0, 4096) : page.url,
        url: page.url,
        navigationRevision: 0,
      }];
    });
    if (tabs.length === 0) return { tabs: [fallback], activeId: fallback.id };
    const activeId = tabs.some((tab) => tab.id === parsed.activeId) ? parsed.activeId! : tabs[0]!.id;
    return { tabs, activeId };
  } catch {
    return { tabs: [fallback], activeId: fallback.id };
  }
}

function browserTabTitle(tab: BrowserPage): string {
  if (!tab.url) return "New tab";
  try {
    const url = new URL(tab.url);
    return url.hostname || "Browser";
  } catch {
    return "Browser";
  }
}

export default function BrowserTab({
  active,
  layoutRevision,
  visualScale = 1,
}: {
  active: boolean;
  layoutRevision?: string;
  visualScale?: number;
}) {
  const [session, setSession] = useState<BrowserSession>(readBrowserSession);
  const [restorePreviousTabs, setRestorePreviousTabs] = useState(restorePreviousTabsEnabled);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pendingNavigation = useBrowserNavigation((state) => state.pending);
  const consumeNavigation = useBrowserNavigation((state) => state.consume);
  const handledNavigationId = useRef<number | null>(null);
  const activeTab = useMemo(
    () => session.tabs.find((tab) => tab.id === session.activeId) ?? session.tabs[0]!,
    [session],
  );

  useEffect(() => {
    window.localStorage.setItem(BROWSER_SETTINGS_KEY, JSON.stringify({ restorePreviousTabs }));
    if (restorePreviousTabs) window.localStorage.setItem(BROWSER_SESSION_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(BROWSER_SESSION_KEY);
  }, [restorePreviousTabs, session]);

  useEffect(() => {
    if (!pendingNavigation || handledNavigationId.current === pendingNavigation.id) return;
    handledNavigationId.current = pendingNavigation.id;
    consumeNavigation(pendingNavigation.id);
    setSettingsOpen(false);
    setMessage(null);
    setSession((current) => {
      const activePage = current.tabs.find((tab) => tab.id === current.activeId);
      const target = activePage && activePage.url === null && activePage.address === ""
        ? activePage
        : current.tabs.length < MAX_BROWSER_TABS
          ? createBrowserPage()
          : activePage ?? current.tabs[0]!;
      const nextPage: BrowserPage = {
        ...target,
        address: pendingNavigation.url,
        url: pendingNavigation.url,
        navigationRevision: target.navigationRevision + 1,
      };
      const replacing = current.tabs.some((tab) => tab.id === target.id);
      return {
        tabs: replacing
          ? current.tabs.map((tab) => tab.id === target.id ? nextPage : tab)
          : [...current.tabs, nextPage],
        activeId: target.id,
      };
    });
  }, [consumeNavigation, pendingNavigation]);

  const updateActiveTab = (update: (tab: BrowserPage) => BrowserPage) => {
    setSession((current) => ({
      ...current,
      tabs: current.tabs.map((tab) => tab.id === current.activeId ? update(tab) : tab),
    }));
  };

  const navigate = (event: FormEvent) => {
    event.preventDefault();
    const resolved = resolveBrowserAddress(activeTab.address);
    if (!resolved) {
      setMessage("Enter a web address or a runtime port such as 127.0.0.1:3000.");
      return;
    }
    setMessage(null);
    updateActiveTab((tab) => ({
      ...tab,
      address: resolved.url,
      url: resolved.url,
      navigationRevision: tab.navigationRevision + 1,
    }));
  };

  const addTab = () => {
    if (session.tabs.length >= MAX_BROWSER_TABS) {
      setMessage(`Browser tabs are limited to ${MAX_BROWSER_TABS}.`);
      return;
    }
    const tab = createBrowserPage();
    setMessage(null);
    setSettingsOpen(false);
    setSession((current) => ({ tabs: [...current.tabs, tab], activeId: tab.id }));
  };

  const closeTab = (tabId: string) => {
    setSession((current) => {
      const closingIndex = current.tabs.findIndex((tab) => tab.id === tabId);
      const remaining = current.tabs.filter((tab) => tab.id !== tabId);
      if (remaining.length === 0) {
        const replacement = createBrowserPage();
        return { tabs: [replacement], activeId: replacement.id };
      }
      if (current.activeId !== tabId) return { ...current, tabs: remaining };
      const replacement = remaining[Math.min(Math.max(closingIndex, 0), remaining.length - 1)]!;
      return { tabs: remaining, activeId: replacement.id };
    });
  };

  const selectTabWithKeyboard = (event: KeyboardEvent<HTMLDivElement>, tabId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setSettingsOpen(false);
    setSession((current) => ({ ...current, activeId: tabId }));
  };

  const activeResolution = activeTab.url ? resolveBrowserAddress(activeTab.url) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" style={{ background: "var(--bg-app)" }}>
      <div
        role="tablist"
        aria-label="Browser tabs"
        className="flex h-10 shrink-0 items-end gap-1 overflow-x-auto border-b px-2 pt-1"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
      >
        {session.tabs.map((tab, index) => {
          const selected = !settingsOpen && tab.id === session.activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className="group flex h-8 min-w-28 max-w-48 cursor-default items-center gap-2 rounded-t-lg border px-2 text-xs"
              style={{
                color: "var(--text-primary)",
                borderColor: selected ? "var(--border-default)" : "transparent",
                background: selected ? "var(--bg-app)" : "transparent",
              }}
              onClick={() => {
                setSettingsOpen(false);
                setSession((current) => ({ ...current, activeId: tab.id }));
              }}
              onKeyDown={(event) => selectTabWithKeyboard(event, tab.id)}
            >
              <Globe2 size={13} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{browserTabTitle(tab)}</span>
              <button
                type="button"
                aria-label={`Close browser tab ${index + 1}`}
                className="inline-flex size-5 shrink-0 items-center justify-center rounded hover:bg-[var(--bg-hover)]"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label="New browser tab"
          className="mb-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
          onClick={addTab}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      <form
        className="flex shrink-0 items-center gap-2 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
        onSubmit={navigate}
      >
        <Globe2 size={15} aria-hidden="true" style={{ color: "var(--text-tertiary)" }} />
        <input
          aria-label="Browser address"
          value={activeTab.address}
          onChange={(event) => updateActiveTab((tab) => ({ ...tab, address: event.target.value }))}
          placeholder="Search or enter 127.0.0.1:3000"
          className="h-8 min-w-0 flex-1 rounded-lg border px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{
            color: "var(--text-primary)",
            background: "var(--bg-app)",
            borderColor: "var(--border-default)",
          }}
        />
        <button
          type="submit"
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-medium"
          style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
        >
          <ExternalLink size={13} aria-hidden="true" />
          Go
        </button>
        {activeResolution?.disposition === "public" ? (
          <button
            type="button"
            aria-label="Open current page in external browser"
            title="Open in external browser"
            className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)]"
            style={{ color: "var(--text-secondary)" }}
            onClick={() => {
              const url = activeTab.url;
              if (!url) return;
              void (async () => {
                try {
                  await invoke("shell:open-external", { url });
                } catch (error: unknown) {
                  console.warn(
                    "[browser] Failed to open the current page externally:",
                    error instanceof Error ? error.name : typeof error,
                  );
                }
              })();
            }}
          >
            <ExternalLink size={15} aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Browser settings"
          aria-pressed={settingsOpen}
          className="inline-flex size-8 items-center justify-center rounded-lg hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-secondary)" }}
          onClick={() => setSettingsOpen((shown) => !shown)}
        >
          <SlidersHorizontalIcon size={15} aria-hidden="true" />
        </button>
      </form>

      {settingsOpen ? (
        <section
          role="region"
          aria-label="Browser settings"
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
          style={{ color: "var(--text-primary)" }}
        >
          <h2 className="text-base font-semibold">Browser settings</h2>
          <div className="mt-5 max-w-xl space-y-4 text-sm">
            <label className="flex items-center justify-between gap-4 rounded-xl border p-4" style={{ borderColor: "var(--border-default)" }}>
              <span>
                <span className="block font-medium">Restore previous tabs</span>
                <span className="mt-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Reopen your tab URLs after restarting Desktop.</span>
              </span>
              <input
                type="checkbox"
                aria-label="Restore previous tabs"
                checked={restorePreviousTabs}
                onChange={(event) => setRestorePreviousTabs(event.target.checked)}
              />
            </label>
            <div className="rounded-xl border p-4" style={{ borderColor: "var(--border-default)" }}>
              <p className="font-medium">Site data</p>
              <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>Cookies and sign-ins persist in the browser profile.</p>
            </div>
            <label className="flex items-start justify-between gap-4 rounded-xl border p-4 opacity-75" style={{ borderColor: "var(--border-default)" }}>
              <span>
                <span className="block font-medium">Save passwords</span>
                <span className="mt-1 block text-xs" style={{ color: "var(--text-secondary)" }}>Password saving requires an OS-encrypted browser vault and is not enabled yet. Matrix will never store passwords in local storage.</span>
              </span>
              <input type="checkbox" aria-label="Save passwords" disabled />
            </label>
          </div>
        </section>
      ) : activeTab.url ? (
        <EmbedHost
          key={`${activeTab.id}:${activeTab.url}:${activeTab.navigationRevision}`}
          kind="browser"
          url={activeTab.url}
          active={active}
          layoutRevision={layoutRevision}
          visualScale={visualScale}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <span
            className="flex size-14 items-center justify-center rounded-2xl"
            style={{ background: "var(--accent-muted)", color: "var(--accent)" }}
          >
            <Globe2 size={26} aria-hidden="true" />
          </span>
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Browser</h2>
            <p className="mt-1 max-w-md text-sm" style={{ color: "var(--text-secondary)" }}>
              Browse public websites normally. Runtime localhost ports stay inside Matrix through the selected computer.
            </p>
          </div>
          {message ? <p role="status" className="text-xs" style={{ color: "var(--text-tertiary)" }}>{message}</p> : null}
        </div>
      )}
    </div>
  );
}
