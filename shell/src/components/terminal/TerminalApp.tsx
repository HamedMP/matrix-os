"use client";

import { createContext, useContext, useEffect, useRef, useCallback, useState } from "react";
import { type PaneNode, countPanes as countPanesFromStore, getAllPaneIds } from "@/stores/terminal-store";
import { PaneGrid } from "./PaneGrid";
import { useTheme } from "@/hooks/useTheme";
import { getGatewayUrl } from "@/lib/gateway";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { useTerminalSettings, type TerminalThemeId } from "@/stores/terminal-settings";
import { TERMINAL_THEME_OPTIONS, getTerminalThemePreset } from "./terminal-themes";

// Map xterm theme ids onto zellij's built-in theme names. Zellij ships with
// these themes in 0.44, so referencing them by name "just works".
const ZELLIJ_THEME_BY_TERMINAL: Record<string, string> = {
  "one-dark": "one-half-dark",
  "one-light": "one-half-light",
  "catppuccin-mocha": "catppuccin-mocha",
  "dracula": "dracula",
  "nord": "nord",
  "solarized-dark": "solarized-dark",
  "solarized-light": "solarized-light",
  "github-dark": "default",
  "github-light": "default",
};

// Build a one-shot shell command that writes a Matrix-owned zellij config
// honoring the user's terminal theme, then launches zellij with that config.
function zellijLaunchCommand(themeId: TerminalThemeId, isLight: boolean): string {
  const mapped = themeId !== "system" ? ZELLIJ_THEME_BY_TERMINAL[themeId] : undefined;
  const fallback = isLight ? "one-half-light" : "default";
  const theme = mapped ?? fallback;
  return `mkdir -p ~/.config/matrix-os && printf 'theme "${theme}"\\n' > ~/.config/matrix-os/zellij.kdl && exec zellij --config ~/.config/matrix-os/zellij.kdl`;
}

function isLightTerminalTheme(themeId: TerminalThemeId, desktopThemeSlug?: string): boolean {
  return (
    themeId === "one-light" ||
    themeId === "solarized-light" ||
    themeId === "github-light" ||
    (themeId === "system" && /light|day/i.test(desktopThemeSlug ?? ""))
  );
}

const DEFAULT_CWD = "projects";

interface Tab {
  id: string;
  label: string;
  paneTree: PaneNode;
}

interface TerminalLayout {
  tabs?: Tab[];
  activeTabId?: string;
  sidebarOpen?: boolean;
}

function genId() {
  return Math.random().toString(36).slice(2, 9);
}

function splitPaneInTree(node: PaneNode, paneId: string, dir: "horizontal" | "vertical"): PaneNode {
  if (node.type === "pane") {
    if (node.id === paneId) {
      return { type: "split", direction: dir, children: [node, { type: "pane", id: genId(), cwd: node.cwd }], ratio: 0.5 };
    }
    return node;
  }
  return { ...node, children: [splitPaneInTree(node.children[0], paneId, dir), splitPaneInTree(node.children[1], paneId, dir)] };
}

function closePaneInTree(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? null : node;
  const l = node.children[0], r = node.children[1];
  if (l.type === "pane" && l.id === paneId) return r;
  if (r.type === "pane" && r.id === paneId) return l;
  const nl = closePaneInTree(l, paneId);
  const nr = closePaneInTree(r, paneId);
  if (!nl) return nr;
  if (!nr) return nl;
  return { ...node, children: [nl, nr] };
}

function getFirstPaneId(node: PaneNode): string {
  if (node.type === "pane") return node.id;
  return getFirstPaneId(node.children[0]);
}

function setPaneSessionId(node: PaneNode, paneId: string, sessionId: string): PaneNode {
  if (node.type === "pane") {
    if (node.id !== paneId || node.sessionId === sessionId) {
      return node;
    }
    return { ...node, sessionId };
  }

  const left = setPaneSessionId(node.children[0], paneId, sessionId);
  const right = setPaneSessionId(node.children[1], paneId, sessionId);
  if (left === node.children[0] && right === node.children[1]) {
    return node;
  }
  return { ...node, children: [left, right] };
}

function hasPaneId(node: PaneNode, paneId: string): boolean {
  if (node.type === "pane") {
    return node.id === paneId;
  }
  return hasPaneId(node.children[0], paneId) || hasPaneId(node.children[1], paneId);
}

function getPaneSessionId(node: PaneNode, paneId: string): string | null {
  if (node.type === "pane") {
    return node.id === paneId ? node.sessionId ?? null : null;
  }
  return getPaneSessionId(node.children[0], paneId) ?? getPaneSessionId(node.children[1], paneId);
}

function getSessionIds(node: PaneNode): string[] {
  if (node.type === "pane") {
    return node.sessionId ? [node.sessionId] : [];
  }
  return [...getSessionIds(node.children[0]), ...getSessionIds(node.children[1])];
}

function terminalAppDebug(event: string, details: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  console.info("[terminal-debug][app]", event, details);
}

const countPanes = countPanesFromStore;

interface TerminalAppProps {
  initialCommand?: string;
  initialSessionId?: string;
}

export function TerminalApp({ initialCommand, initialSessionId }: TerminalAppProps = {}) {
  const theme = useTheme();
  const themeId = useTerminalSettings((s) => s.themeId);
  const setTerminalThemeId = useTerminalSettings((s) => s.setThemeId);
  const isLightTheme = isLightTerminalTheme(themeId, (theme as { slug?: string }).slug);

  // Match the padding around the xterm to the active terminal theme so the
  // user never sees a colored seam between the OS theme bg and the xterm
  // bg. Falls back to the desktop theme bg when "Match OS" is selected.
  const terminalBackground =
    themeId === "system"
      ? (theme.colors.background || "var(--background)")
      : getTerminalThemePreset(themeId).background;

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const themeIdRef = useRef(themeId);
  themeIdRef.current = themeId;
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  const pendingPaneSessionsRef = useRef<Map<string, string>>(new Map());
  const closingPaneIdsRef = useRef<Set<string>>(new Set());
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const log = useCallback((event: string, details: Record<string, unknown> = {}) => {
    terminalAppDebug(event, {
      activeTabId: activeTabIdRef.current,
      focusedPaneId,
      tabIds: tabsRef.current.map((tab) => tab.id),
      ...details,
    });
  }, [focusedPaneId]);

  const persistLayoutNow = useCallback(() => {
    const layout: TerminalLayout = {
      tabs: tabsRef.current,
      activeTabId: activeTabIdRef.current,
      sidebarOpen: sidebarOpenRef.current,
    };

    return fetch(`${getGatewayUrl()}/api/terminal/layout`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(layout),
      keepalive: true,
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      console.warn("Failed to save terminal layout:", err instanceof Error ? err.message : err);
    });
  }, []);

  const destroyTerminalSessions = useCallback((sessionIds: string[]) => {
    const uniqueIds = Array.from(new Set(sessionIds.filter((sessionId) => sessionId.length > 0)));
    for (const sessionId of uniqueIds) {
      void fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        keepalive: true,
        signal: AbortSignal.timeout(5_000),
      }).catch((err: unknown) => {
        console.warn(
          `Failed to destroy terminal session "${sessionId}" on explicit close:`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }, []);

  const getPendingSessionIds = useCallback((paneIds: string[]) => {
    const seen = new Set<string>();
    for (const paneId of paneIds) {
      const sessionId = pendingPaneSessionsRef.current.get(paneId);
      if (sessionId) {
        seen.add(sessionId);
      }
    }
    return Array.from(seen);
  }, []);

  const markPanesClosing = useCallback((paneIds: string[]) => {
    for (const paneId of paneIds) {
      closingPaneIdsRef.current.add(paneId);
    }
    setTimeout(() => {
      for (const paneId of paneIds) {
        closingPaneIdsRef.current.delete(paneId);
      }
    }, 0);
  }, []);

  const addTab = useCallback(
    (cwd: string, label?: string, claude?: boolean, startupCommand?: string, sessionId?: string) => {
      const id = genId();
      const paneId = genId();
      const basename = cwd.split("/").filter(Boolean).pop() ?? "~";
      const tab: Tab = {
        id,
        label: label ?? basename,
        paneTree: {
          type: "pane",
          id: paneId,
          cwd,
          claudeMode: claude,
          startupCommand,
          sessionId,
        },
      };
      setTabs((prev) => [...prev, tab]);
      setActiveTabId(id);
      setFocusedPaneId(paneId);
      return id;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function initLayout() {
      if (initialCommand) {
        addTab(DEFAULT_CWD, "Claude Code", true);
        if (!cancelled) setInitialized(true);
        return;
      }

      if (initialSessionId) {
        addTab(DEFAULT_CWD, "Canvas Terminal", false, undefined, initialSessionId);
        if (!cancelled) setInitialized(true);
        return;
      }

      try {
        const res = await fetch(`${getGatewayUrl()}/api/terminal/layout`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = await res.json() as TerminalLayout;
          if (!cancelled && Array.isArray(data.tabs) && data.tabs.length > 0) {
            const nextActiveTabId = data.activeTabId ?? data.tabs[0].id;
            const nextActiveTab = data.tabs.find((tab) => tab.id === nextActiveTabId) ?? data.tabs[0];
            setTabs(data.tabs);
            setActiveTabId(nextActiveTabId);
            setSidebarOpen(data.sidebarOpen ?? true);
            setFocusedPaneId(nextActiveTab ? getFirstPaneId(nextActiveTab.paneTree) : null);
            setInitialized(true);
            return;
          }
        }
      } catch (err: unknown) {
        console.warn("Failed to load terminal layout:", err instanceof Error ? err.message : err);
      }

      if (!cancelled) {
        addTab(DEFAULT_CWD);
        setInitialized(true);
      }
    }

    void initLayout();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!initialized) {
      return;
    }

    if (layoutSaveTimerRef.current) {
      clearTimeout(layoutSaveTimerRef.current);
    }

    layoutSaveTimerRef.current = setTimeout(() => {
      layoutSaveTimerRef.current = null;
      void persistLayoutNow();
    }, 500);

    return () => {
      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }
    };
  }, [initialized, activeTabId, persistLayoutNow, sidebarOpen, tabs]);

  useEffect(() => {
    const flushOnPageHide = () => {
      if (!initialized) {
        return;
      }

      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }

      void persistLayoutNow();
    };

    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
    };
  }, [initialized, persistLayoutNow]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      if ((entries[0]?.contentRect.width ?? 0) < 500 && sidebarOpen) setSidebarOpen(false);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [sidebarOpen]);

  const closeTab = useCallback((tabId: string) => {
    const closingTab = tabsRef.current.find((tab) => tab.id === tabId);
    if (closingTab) {
      const paneIds = getAllPaneIds(closingTab.paneTree);
      destroyTerminalSessions([
        ...getSessionIds(closingTab.paneTree),
        ...getPendingSessionIds(paneIds),
      ]);
      markPanesClosing(paneIds);
    }
    log("close-tab", {
      tabId,
      paneIds: tabsRef.current.find((tab) => tab.id === tabId)?.paneTree ? getAllPaneIds(tabsRef.current.find((tab) => tab.id === tabId)!.paneTree) : [],
    });
    setTabs(prev => {
      const next = prev.filter(t => t.id !== tabId);
      setActiveTabId(curr => {
        if (curr !== tabId) return curr;
        const idx = prev.findIndex(t => t.id === tabId);
        return next[Math.min(idx, next.length - 1)]?.id ?? "";
      });
      return next;
    });
  }, [destroyTerminalSessions, getPendingSessionIds, log, markPanesClosing]);

  const splitPane = useCallback((paneId: string, dir: "horizontal" | "vertical") => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId || countPanes(t.paneTree) >= 4) return t;
      return { ...t, paneTree: splitPaneInTree(t.paneTree, paneId, dir) };
    }));
  }, [activeTabId]);

  const closePane = useCallback((paneId: string) => {
    const activeTabRecord = tabsRef.current.find((tab) => tab.id === activeTabId);
    const closingSessionIds = new Set<string>();
    const closingSessionId = activeTabRecord ? getPaneSessionId(activeTabRecord.paneTree, paneId) : null;
    if (closingSessionId) closingSessionIds.add(closingSessionId);
    const pendingSessionId = pendingPaneSessionsRef.current.get(paneId);
    if (pendingSessionId) closingSessionIds.add(pendingSessionId);
    destroyTerminalSessions(Array.from(closingSessionIds));
    markPanesClosing([paneId]);
    log("close-pane", { paneId });
    setTabs(prev => {
      const tab = prev.find(t => t.id === activeTabId);
      if (!tab) return prev;
      const newTree = closePaneInTree(tab.paneTree, paneId);
      if (!newTree) {
        const next = prev.filter(t => t.id !== activeTabId);
        setActiveTabId(next[0]?.id ?? "");
        setFocusedPaneId(null);
        return next;
      }
      setFocusedPaneId(getFirstPaneId(newTree));
      return prev.map(t => t.id === activeTabId ? { ...t, paneTree: newTree } : t);
    });
  }, [activeTabId, destroyTerminalSessions, log, markPanesClosing]);

  const renameTab = useCallback((tabId: string, label: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, label } : t));
  }, []);

  const reorderTabs = useCallback((from: number, to: number) => {
    setTabs(prev => {
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
  }, []);

  const getCwd = useCallback(() => sidebarSelectedPath ?? DEFAULT_CWD, [sidebarSelectedPath]);

  const handleSessionAttached = useCallback((paneId: string, sessionId: string) => {
    log("session-attached", { paneId, sessionId });
    pendingPaneSessionsRef.current.set(paneId, sessionId);
    setTabs((prev) => {
      const nextTabs = prev.map((tab) => {
        const nextTree = setPaneSessionId(tab.paneTree, paneId, sessionId);
        return nextTree === tab.paneTree ? tab : { ...tab, paneTree: nextTree };
      });
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  }, [log]);

  const shouldCachePane = useCallback((paneId: string) => {
    const keep = !closingPaneIdsRef.current.has(paneId) && tabsRef.current.some((tab) => hasPaneId(tab.paneTree, paneId));
    log("should-cache-pane", {
      paneId,
      keep,
      tabs: tabsRef.current.map((tab) => ({
        tabId: tab.id,
        paneIds: getAllPaneIds(tab.paneTree),
      })),
    });
    return keep;
  }, [log]);

  const shouldDestroyPane = useCallback((paneId: string) => {
    return closingPaneIdsRef.current.has(paneId);
  }, []);

  useEffect(() => {
    const livePaneIds = new Set<string>();
    for (const tab of tabs) {
      for (const paneId of getAllPaneIds(tab.paneTree)) {
        livePaneIds.add(paneId);
      }
    }
    for (const paneId of Array.from(pendingPaneSessionsRef.current.keys())) {
      if (!livePaneIds.has(paneId)) {
        pendingPaneSessionsRef.current.delete(paneId);
      }
    }

    log("tabs-changed", {
      tabs: tabs.map((tab) => ({
        tabId: tab.id,
        paneIds: getAllPaneIds(tab.paneTree),
      })),
    });
  }, [log, tabs]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    switch (e.key.toUpperCase()) {
      case "T": e.preventDefault(); addTab(getCwd()); break;
      case "W": e.preventDefault(); if (focusedPaneId) closePane(focusedPaneId); break;
      case "D": e.preventDefault(); if (focusedPaneId) splitPane(focusedPaneId, "horizontal"); break;
      case "E": e.preventDefault(); if (focusedPaneId) splitPane(focusedPaneId, "vertical"); break;
      case "B": e.preventDefault(); setSidebarOpen(o => !o); break;
      case "C": e.preventDefault(); addTab(getCwd(), "Claude Code", true); break;
      case "Z": e.preventDefault(); addTab(getCwd(), "Zellij", false, zellijLaunchCommand(themeIdRef.current, isLightTheme)); break;
    }
  }, [addTab, closePane, splitPane, focusedPaneId, getCwd, isLightTheme]);

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Construct store-compatible interface for child components
  const storeApi = {
    tabs, activeTabId, sidebarOpen, sidebarSelectedPath, focusedPaneId,
    addTab, closeTab, setActiveTab: setActiveTabId, renameTab, reorderTabs,
    splitPane, closePane, setFocusedPane: setFocusedPaneId,
    setSidebarOpen, setSidebarSelectedPath,
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full"
      style={{ background: "var(--background)" }}
      onKeyDown={handleKeyDown}
    >
      <TerminalAppContext.Provider value={storeApi}>
        <LocalTerminalTabBar defaultCwd={DEFAULT_CWD} isLightTheme={isLightTheme} />
        <div className="flex flex-1 min-h-0">
          <LocalTerminalSidebar />
          {activeTab ? (
            <div
              className="flex-1 min-w-0 min-h-0 flex"
              style={{ padding: "8px 10px 8px 12px", background: terminalBackground }}
            >
              <PaneGrid
                paneTree={activeTab.paneTree}
                theme={theme}
                focusedPaneId={focusedPaneId}
                onFocusPane={setFocusedPaneId}
                onSessionAttached={handleSessionAttached}
                shouldCachePane={shouldCachePane}
                shouldDestroyPane={shouldDestroyPane}
              />
            </div>
          ) : !initialized ? (
            <div className="flex-1" style={{ background: "var(--background)" }} />
          ) : (
            <div className="flex-1 flex items-center justify-center" style={{ color: "var(--muted-foreground)" }}>
              <div className="text-center">
                <p className="text-sm mb-2">No terminal tabs open</p>
                <button
                  className="text-xs px-3 py-1.5 rounded cursor-pointer"
                  style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
                  onClick={() => addTab(DEFAULT_CWD)}
                >
                  New Terminal
                </button>
              </div>
            </div>
          )}
        </div>
      </TerminalAppContext.Provider>
    </div>
  );
}

// ---- Context for local state ----

interface TerminalAppContextType {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  sidebarSelectedPath: string | null;
  focusedPaneId: string | null;
  addTab: (cwd: string, label?: string, claude?: boolean, startupCommand?: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, label: string) => void;
  reorderTabs: (from: number, to: number) => void;
  splitPane: (paneId: string, dir: "horizontal" | "vertical") => void;
  closePane: (paneId: string) => void;
  setFocusedPane: (paneId: string) => void;
  setSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setSidebarSelectedPath: (path: string | null) => void;
}

const TerminalAppContext = createContext<TerminalAppContextType | null>(null);

function useTerminalAppContext() {
  const ctx = useContext(TerminalAppContext);
  if (!ctx) throw new Error("Must be inside TerminalApp");
  return ctx;
}

// ---- Local versions of TabBar and Sidebar that use context instead of global store ----

const ICON_SIZE = 16;

function IconPlus() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}
function IconSplitH() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <line x1="8" y1="3" x2="8" y2="13" />
    </svg>
  );
}
function IconSplitV() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="3" y1="3" x2="9" y2="9" />
      <line x1="9" y1="3" x2="3" y2="9" />
    </svg>
  );
}
function IconPalette() {
  return (
    <svg width={ICON_SIZE} height={ICON_SIZE} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M8 2c-3.3 0-6 2.4-6 5.5 0 1.7 1.3 3 3 3h1c.6 0 1 .4 1 1v.5c0 1.1.9 2 2 2h.2c2.7 0 4.8-2.2 4.8-4.9V7.5C14 4.4 11.3 2 8 2z" />
      <circle cx="5" cy="6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="8" cy="4.5" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="11" cy="6" r="0.7" fill="currentColor" stroke="none" />
      <circle cx="11.5" cy="9" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

interface ToolbarBtnProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  variant?: "default" | "primary" | "success";
}
function ToolbarBtn({ onClick, title, children, variant = "default" }: ToolbarBtnProps) {
  const colors =
    variant === "success"
      ? { bg: "var(--success)", color: "white", border: "transparent" }
      : variant === "primary"
        ? { bg: "var(--primary)", color: "white", border: "transparent" }
        : { bg: "transparent", color: "var(--muted-foreground)", border: "transparent" };
  return (
    <button
      className="cursor-pointer transition-colors flex items-center justify-center gap-1.5"
      style={{
        height: 28,
        minWidth: 28,
        padding: variant === "default" ? "0 6px" : "0 10px",
        fontSize: 12,
        fontWeight: variant === "default" ? 400 : 500,
        borderRadius: 6,
        background: colors.bg,
        color: colors.color,
        border: `1px solid ${colors.border}`,
      }}
      onMouseEnter={(e) => {
        if (variant === "default") {
          e.currentTarget.style.background = "var(--accent)";
          e.currentTarget.style.color = "var(--foreground)";
        } else {
          e.currentTarget.style.opacity = "0.85";
        }
      }}
      onMouseLeave={(e) => {
        if (variant === "default") {
          e.currentTarget.style.background = "transparent";
          e.currentTarget.style.color = "var(--muted-foreground)";
        } else {
          e.currentTarget.style.opacity = "1";
        }
      }}
      onClick={onClick}
      title={title}
    >
      {children}
    </button>
  );
}

function ThemePickerButton() {
  const themeId = useTerminalSettings((s) => s.themeId);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const current = TERMINAL_THEME_OPTIONS.find((o) => o.id === themeId) ?? TERMINAL_THEME_OPTIONS[0];

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <ToolbarBtn onClick={() => setOpen((o) => !o)} title={`Terminal theme: ${current.label}`}>
        <IconPalette />
      </ToolbarBtn>
      {open && (
        <div
          style={{
            position: "absolute",
            top: 32,
            right: 0,
            zIndex: 50,
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.18)",
            padding: 4,
            minWidth: 180,
          }}
        >
          <div style={{ padding: "6px 10px", fontSize: 10, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: 0.5 }}>
            Terminal Theme
          </div>
          {TERMINAL_THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => { setThemeId(opt.id); setOpen(false); }}
              className="w-full flex items-center gap-2 cursor-pointer transition-colors"
              style={{
                padding: "6px 10px",
                fontSize: 12,
                background: opt.id === themeId ? "var(--accent)" : "transparent",
                color: "var(--foreground)",
                border: "none",
                textAlign: "left",
                borderRadius: 4,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "var(--accent)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = opt.id === themeId ? "var(--accent)" : "transparent"; }}
            >
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: opt.id === themeId ? "var(--primary)" : "var(--border)" }} />
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LocalTerminalTabBar({ defaultCwd, isLightTheme }: { defaultCwd: string; isLightTheme: boolean }) {
  const ctx = useTerminalAppContext();
  const themeId = useTerminalSettings((s) => s.themeId);
  const dragIndexRef = useRef<number | null>(null);

  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;

  return (
    <div
      className="flex items-stretch border-b shrink-0 select-none"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
        height: 40,
        padding: "4px 6px",
        gap: 4,
      }}
    >
      <div className="flex items-stretch overflow-x-auto flex-1 min-w-0" style={{ gap: 2 }}>
        {ctx.tabs.map((tab, i) => {
          const active = tab.id === ctx.activeTabId;
          return (
            <div
              key={tab.id}
              className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
              style={{
                background: active ? "var(--background)" : "transparent",
                color: active ? "var(--foreground)" : "var(--muted-foreground)",
                border: `1px solid ${active ? "var(--border)" : "transparent"}`,
                borderRadius: 6,
                padding: "0 10px",
                fontSize: 12,
                height: 30,
                fontWeight: active ? 500 : 400,
              }}
              draggable
              onClick={() => ctx.setActiveTab(tab.id)}
              onDragStart={() => { dragIndexRef.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragIndexRef.current !== null && dragIndexRef.current !== i) ctx.reorderTabs(dragIndexRef.current, i); dragIndexRef.current = null; }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: active ? "var(--success)" : "var(--muted-foreground)",
                  opacity: active ? 1 : 0.5,
                }}
              />
              <span style={{ maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{tab.label}</span>
              <button
                className="cursor-pointer flex items-center justify-center transition-colors"
                onClick={(e) => { e.stopPropagation(); ctx.closeTab(tab.id); }}
                style={{
                  width: 16,
                  height: 16,
                  borderRadius: 3,
                  border: "none",
                  background: "transparent",
                  color: "var(--muted-foreground)",
                  opacity: 0.5,
                  marginLeft: 2,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.background = "var(--accent)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.5"; e.currentTarget.style.background = "transparent"; }}
                aria-label="Close tab"
                title="Close tab"
              >
                <IconClose />
                <span className="sr-only">x</span>
              </button>
            </div>
          );
        })}
      </div>
      <div className="flex items-center shrink-0" style={{ gap: 4, paddingLeft: 8, borderLeft: "1px solid var(--border)" }}>
        <ToolbarBtn
          onClick={() => ctx.addTab(getCwd(), "Claude Code", true)}
          title="Launch Claude Code (Ctrl+Shift+C)"
          variant="success"
        >
          Claude
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => ctx.addTab(getCwd(), "Zellij", false, zellijLaunchCommand(themeId, isLightTheme))}
          title="Launch Zellij (Ctrl+Shift+Z)"
          variant="primary"
        >
          Zellij
        </ToolbarBtn>
        <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
        <ToolbarBtn
          onClick={() => { if (ctx.focusedPaneId) ctx.splitPane(ctx.focusedPaneId, "horizontal"); }}
          title="Split horizontally (Ctrl+Shift+D)"
        >
          <IconSplitH />
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => { if (ctx.focusedPaneId) ctx.splitPane(ctx.focusedPaneId, "vertical"); }}
          title="Split vertically (Ctrl+Shift+E)"
        >
          <IconSplitV />
        </ToolbarBtn>
        <ToolbarBtn
          onClick={() => ctx.addTab(getCwd())}
          title="New tab (Ctrl+Shift+T)"
        >
          <IconPlus />
        </ToolbarBtn>
        <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
        <ThemePickerButton />
      </div>
    </div>
  );
}

interface ProjectInfo {
  name: string;
  path: string;
  isGit: boolean;
  branch: string | null;
  dirtyCount: number;
  modified: string | null;
}

type SidebarTab = "projects" | "files";

function LocalTerminalSidebar() {
  const ctx = useTerminalAppContext();
  const theme = useTheme();
  const themeId = useTerminalSettings((s) => s.themeId);
  const isLightSidebar = isLightTerminalTheme(themeId, (theme as { slug?: string }).slug);
  const [tab, setTab] = useState<SidebarTab>("projects");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState("projects");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [filter, setFilter] = useState("");

  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    try {
      const res = await fetch(`${getGatewayUrl()}/api/projects?root=projects`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        setProjectsError("Failed to load projects");
        setProjects([]);
        return;
      }
      const data = (await res.json()) as { projects?: ProjectInfo[] };
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("Failed to load projects:", msg);
      setProjectsError("Could not reach gateway");
      setProjects([]);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "projects") void fetchProjects();
  }, [tab, fetchProjects]);

  const fetchDir = useCallback(async (path: string) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/files/tree?path=${encodeURIComponent(path)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      return res.json();
    } catch (err: unknown) {
      console.warn("Failed to load terminal directory tree:", err instanceof Error ? err.message : err);
      return [];
    }
  }, []);

  useEffect(() => {
    if (tab !== "files") return;
    fetchDir(rootPath).then((entries: TreeNode[]) => setTree(entries.map(e => ({ ...e, path: `${rootPath}/${e.name}` }))));
  }, [rootPath, fetchDir, tab]);

  const toggleExpand = useCallback(async (node: TreeNode) => {
    if (node.type !== "directory") return;
    if (node.expanded) { setTree(prev => updateNode(prev, node.path, { expanded: false })); return; }
    const children = await fetchDir(node.path);
    setTree(prev => updateNode(prev, node.path, { expanded: true, children: children.map((c: TreeNode) => ({ ...c, path: `${node.path}/${c.name}` })) }));
  }, [fetchDir]);

  if (!ctx.sidebarOpen) {
    return (
      <div className="flex flex-col items-center py-2 gap-2 shrink-0" style={{ width: 40, background: "var(--card)", borderRight: "1px solid var(--border)" }}>
        <button
          className="flex items-center justify-center rounded cursor-pointer hover:bg-[var(--accent)] transition-colors"
          style={{ width: 28, height: 28, fontSize: 14 }}
          onClick={() => ctx.setSidebarOpen(true)}
          title="Open sidebar (Ctrl+Shift+B)"
        >
          ☰
        </button>
      </div>
    );
  }

  const isAtRoot = !rootPath || rootPath === ".";
  const filteredProjects = filter
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : projects;

  return (
    <div className="flex flex-col shrink-0 overflow-hidden" style={{ width: 240, background: "var(--card)", borderRight: "1px solid var(--border)", paddingLeft: 4 }}>
      <div className="flex items-stretch shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
        <button
          className="flex-1 flex items-center justify-center gap-1.5 text-[11px] cursor-pointer transition-colors"
          style={{
            padding: "8px 6px",
            background: tab === "projects" ? "var(--background)" : "transparent",
            color: tab === "projects" ? "var(--foreground)" : "var(--muted-foreground)",
            borderBottom: tab === "projects" ? "2px solid var(--primary)" : "2px solid transparent",
            fontWeight: 500,
            letterSpacing: "0.3px",
          }}
          onClick={() => setTab("projects")}
        >
          <span style={{ fontSize: 12 }}>◆</span> Projects
        </button>
        <button
          className="flex-1 flex items-center justify-center gap-1.5 text-[11px] cursor-pointer transition-colors"
          style={{
            padding: "8px 6px",
            background: tab === "files" ? "var(--background)" : "transparent",
            color: tab === "files" ? "var(--foreground)" : "var(--muted-foreground)",
            borderBottom: tab === "files" ? "2px solid var(--primary)" : "2px solid transparent",
            fontWeight: 500,
            letterSpacing: "0.3px",
          }}
          onClick={() => setTab("files")}
        >
          <span style={{ fontSize: 12 }}>▤</span> Files
        </button>
        <button
          className="flex items-center justify-center cursor-pointer hover:bg-[var(--accent)] transition-colors"
          style={{ width: 28, color: "var(--muted-foreground)", fontSize: 14 }}
          onClick={() => ctx.setSidebarOpen(false)}
          title="Hide sidebar (Ctrl+Shift+B)"
        >
          ‹
        </button>
      </div>

      {tab === "projects" ? (
        <>
          <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter..."
              className="flex-1 text-[11px] outline-none"
              style={{
                background: "var(--background)",
                color: "var(--foreground)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                padding: "3px 6px",
              }}
            />
            <button
              onClick={() => void fetchProjects()}
              className="cursor-pointer hover:bg-[var(--accent)] rounded transition-colors"
              style={{ color: "var(--muted-foreground)", fontSize: 12, padding: "2px 6px" }}
              title="Refresh"
            >
              ↻
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-1">
            {projectsLoading && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                Loading projects…
              </div>
            )}
            {!projectsLoading && projectsError && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--destructive)" }}>
                {projectsError}
              </div>
            )}
            {!projectsLoading && !projectsError && filteredProjects.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                {filter ? "No matches" : (
                  <>
                    <div style={{ fontSize: 22, marginBottom: 6 }}>◇</div>
                    <div style={{ marginBottom: 4 }}>No projects yet</div>
                    <div style={{ opacity: 0.7 }}>Create or clone into <code>~/projects</code></div>
                  </>
                )}
              </div>
            )}
            {!projectsLoading && filteredProjects.map((p) => (
              <ProjectCard
                key={p.path}
                project={p}
                onOpenShell={() => ctx.addTab(p.path, p.name)}
                onOpenClaude={() => ctx.addTab(p.path, `${p.name} · claude`, true)}
                onOpenZellij={() => ctx.addTab(p.path, `${p.name} · zellij`, false, zellijLaunchCommand(themeId, isLightSidebar))}
                onSelect={() => ctx.setSidebarSelectedPath(p.path)}
                isSelected={ctx.sidebarSelectedPath === p.path}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-center gap-1 px-2 py-1.5 text-[10px] shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
            {!isAtRoot && (
              <button
                className="text-xs opacity-60 hover:opacity-100 cursor-pointer"
                onClick={() => { const p = rootPath.split("/").filter(Boolean); p.pop(); setRootPath(p.join("/") || ""); }}
                style={{ color: "var(--muted-foreground)" }}
              >
                ←
              </button>
            )}
            <span
              className="text-[10px] truncate"
              style={{ color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.5px" }}
            >
              {rootPath || "~"}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto py-1 text-xs">
            {tree.map(node => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selectedPath={ctx.sidebarSelectedPath}
                onToggle={toggleExpand}
                onSelect={(n) => { if (n.type === "directory") ctx.setSidebarSelectedPath(n.path); }}
                onOpenTerminal={(path) => ctx.addTab(path)}
              />
            ))}
            {tree.length === 0 && (
              <div className="px-3 py-4 text-center" style={{ color: "var(--muted-foreground)" }}>
                Empty directory
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface ProjectCardProps {
  project: ProjectInfo;
  onOpenShell: () => void;
  onOpenClaude: () => void;
  onOpenZellij: () => void;
  onSelect: () => void;
  isSelected: boolean;
}

function ProjectCard({ project, onOpenShell, onOpenClaude, onOpenZellij, onSelect, isSelected }: ProjectCardProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="cursor-pointer transition-colors"
      style={{
        margin: "3px 8px",
        padding: "8px 10px 6px",
        borderRadius: 6,
        background: isSelected ? "var(--accent)" : hover ? "var(--accent)" : "transparent",
        border: `1px solid ${isSelected ? "var(--primary)" : "transparent"}`,
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={onSelect}
      onDoubleClick={onOpenShell}
      title={`${project.path}\nDouble-click to open terminal`}
    >
      <div className="flex items-center gap-1.5" style={{ marginBottom: 4 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: project.dirtyCount > 0 ? "var(--warning)" : project.isGit ? "var(--success)" : "var(--muted-foreground)",
            flexShrink: 0,
          }}
        />
        <span
          className="text-[12px] truncate flex-1"
          style={{ color: "var(--foreground)", fontWeight: 500 }}
        >
          {project.name}
        </span>
      </div>
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color: "var(--muted-foreground)", paddingLeft: 12 }}>
        {project.isGit && project.branch && (
          <span
            style={{
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--background)",
              border: "1px solid var(--border)",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              maxWidth: 100,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {project.branch}
          </span>
        )}
        {project.dirtyCount > 0 && (
          <span
            style={{
              padding: "1px 5px",
              borderRadius: 3,
              background: "var(--warning)",
              color: "var(--card)",
              fontWeight: 600,
            }}
          >
            {project.dirtyCount}
          </span>
        )}
        {!project.isGit && <span style={{ opacity: 0.6 }}>folder</span>}
      </div>
      <div
        className="flex items-center gap-1"
        style={{
          marginTop: 6,
          paddingLeft: 12,
          opacity: hover || isSelected ? 1 : 0,
          maxHeight: hover || isSelected ? 22 : 0,
          overflow: "hidden",
          transition: "opacity 120ms, max-height 120ms",
        }}
      >
        <ProjectActionBtn label="Shell" onClick={(e) => { e.stopPropagation(); onOpenShell(); }} />
        <ProjectActionBtn label="Claude" onClick={(e) => { e.stopPropagation(); onOpenClaude(); }} accent="var(--success)" />
        <ProjectActionBtn label="Zellij" onClick={(e) => { e.stopPropagation(); onOpenZellij(); }} accent="var(--primary)" />
      </div>
    </div>
  );
}

function ProjectActionBtn({
  label,
  onClick,
  accent,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  accent?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="text-[10px] cursor-pointer transition-colors"
      style={{
        padding: "2px 6px",
        borderRadius: 3,
        background: accent ?? "var(--background)",
        color: accent ? "white" : "var(--foreground)",
        border: accent ? "none" : "1px solid var(--border)",
        opacity: 0.9,
      }}
    >
      {label}
    </button>
  );
}

// ---- Tree helpers ----

interface TreeNode { name: string; type: "file" | "directory"; size?: number; gitStatus: string | null; changedCount?: number; path: string; children?: TreeNode[]; expanded?: boolean; }

const GIT_COLORS: Record<string, string> = { modified: "var(--warning)", added: "var(--success)", untracked: "var(--success)", deleted: "var(--destructive)", renamed: "var(--primary)" };

function TreeItem({ node, depth, selectedPath, onToggle, onSelect, onOpenTerminal }: { node: TreeNode; depth: number; selectedPath: string | null; onToggle: (n: TreeNode) => void; onSelect: (n: TreeNode) => void; onOpenTerminal: (path: string) => void }) {
  return (
    <>
      <div
        className="flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-[var(--accent)] transition-colors"
        style={{ paddingLeft: 8 + depth * 12, background: selectedPath === node.path ? "var(--accent)" : undefined, color: (node.gitStatus && GIT_COLORS[node.gitStatus]) ?? "var(--foreground)" }}
        onClick={() => { if (node.type === "directory") { onToggle(node); onSelect(node); } }}
        onDoubleClick={() => { if (node.type === "directory") onOpenTerminal(node.path); }}
      >
        {node.type === "directory" ? <span className="text-[10px] opacity-60" style={{ width: 10 }}>{node.expanded ? "▾" : "▸"}</span> : <span style={{ width: 10 }} />}
        <span className="truncate flex-1">{node.name}</span>
        {node.type === "directory" && (node.changedCount ?? 0) > 0 && <span className="text-[9px] px-1 rounded" style={{ background: "var(--warning)", color: "var(--card)", opacity: 0.8 }}>{node.changedCount}</span>}
      </div>
      {node.expanded && node.children?.map(c => <TreeItem key={c.path} node={c} depth={depth + 1} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} onOpenTerminal={onOpenTerminal} />)}
    </>
  );
}

function updateNode(nodes: TreeNode[], path: string, update: Partial<TreeNode>): TreeNode[] {
  return nodes.map(n => {
    if (n.path === path) return { ...n, ...update };
    if (n.children) return { ...n, children: updateNode(n.children, path, update) };
    return n;
  });
}
