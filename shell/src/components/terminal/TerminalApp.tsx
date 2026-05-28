"use client";

import { createContext, useContext, useEffect, useRef, useCallback, useState } from "react";
import {
  BotIcon,
  FilesIcon,
  FolderIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlusIcon,
  RefreshCwIcon,
  TerminalIcon,
} from "lucide-react";
import { type PaneNode, countPanes as countPanesFromStore, getAllPaneIds } from "@/stores/terminal-store";
import { PaneGrid } from "./PaneGrid";
import { useTheme } from "@/hooks/useTheme";
import { getGatewayUrl } from "@/lib/gateway";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { drainTerminalLaunchQueue, TERMINAL_LAUNCH_EVENT } from "@/lib/terminal-launch";
import { useTerminalSettings } from "@/stores/terminal-settings";
import { getTerminalThemePreset } from "./terminal-themes";
import { TerminalPreferencesPanel } from "./preferences-panel";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { isCanonicalShellSessionId } from "./TerminalPane";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";

export { TERMINAL_INPUT_EVENT };
export type { TerminalInputEventDetail };

function dispatchPaneInput(paneId: string | null, data: string): void {
  if (!paneId) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalInputEventDetail>(TERMINAL_INPUT_EVENT, {
      detail: { paneId, data },
    }),
  );
}

const DEFAULT_CWD = "projects";
const DEFAULT_SHELL_SESSION_NAME = "main";

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

function getPaneCwd(node: PaneNode, paneId: string): string | null {
  if (node.type === "pane") {
    return node.id === paneId ? node.cwd : null;
  }
  return getPaneCwd(node.children[0], paneId) ?? getPaneCwd(node.children[1], paneId);
}

function formatCwd(value: string): string {
  if (value === DEFAULT_CWD) return "~/projects";
  if (value.startsWith(DEFAULT_CWD + "/")) return `~/${value}`;
  return value;
}

function getSessionIds(node: PaneNode): string[] {
  if (node.type === "pane") {
    return node.sessionId ? [node.sessionId] : [];
  }
  return [...getSessionIds(node.children[0]), ...getSessionIds(node.children[1])];
}

function layoutUsesOnlyCanonicalShellSessions(layout: TerminalLayout): boolean {
  if (!Array.isArray(layout.tabs) || layout.tabs.length === 0) {
    return false;
  }
  const sessionIds = layout.tabs.flatMap((tab) => getSessionIds(tab.paneTree));
  return sessionIds.length > 0 && sessionIds.every((sessionId) => isCanonicalShellSessionId(sessionId));
}

async function ensureDefaultShellSession(): Promise<boolean> {
  try {
    const listRes = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (listRes.ok) {
      const data = await listRes.json() as { sessions?: Array<{ name?: unknown }> };
      if (Array.isArray(data.sessions) && data.sessions.some((session) => session.name === DEFAULT_SHELL_SESSION_NAME)) {
        return true;
      }
    }

    const createRes = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: DEFAULT_SHELL_SESSION_NAME, cwd: DEFAULT_CWD }),
      signal: AbortSignal.timeout(10_000),
    });
    return createRes.ok || createRes.status === 409;
  } catch (err: unknown) {
    console.warn("Failed to ensure default terminal session:", err instanceof Error ? err.message : err);
    return false;
  }
}

function getSafePreferencesSessionName(value: string | null): string | null {
  return value && /^[a-z0-9][a-z0-9-]{0,30}$/.test(value) ? value : null;
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
  initialLabel?: string;
  initialClaudeMode?: boolean;
  initialSessionId?: string;
  launchTargetId?: string;
  mobile?: boolean;
}

export function TerminalApp({ initialCommand, initialLabel, initialClaudeMode = false, initialSessionId, launchTargetId, mobile = false }: TerminalAppProps = {}) {
  const theme = useTheme();
  const themeId = useTerminalSettings((s) => s.themeId);

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
  const [sidebarOpen, setSidebarOpen] = useState(!mobile);
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  activeTabIdRef.current = activeTabId;
  const initialMobileRef = useRef(mobile);
  const sidebarOpenRef = useRef(sidebarOpen);
  sidebarOpenRef.current = sidebarOpen;
  const mountedRef = useRef(false);
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
      ...(initialMobileRef.current ? {} : { sidebarOpen: sidebarOpenRef.current }),
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
      const isCanonical = isCanonicalShellSessionId(sessionId);
      const path = isCanonical
        ? `/api/terminal/sessions/${encodeURIComponent(sessionId)}?force=1`
        : `/api/terminal/pty-sessions/${encodeURIComponent(sessionId)}`;
      void fetch(`${getGatewayUrl()}${path}`, {
        method: "DELETE",
        keepalive: true,
        signal: AbortSignal.timeout(5_000),
      }).then((res) => {
        if (!res.ok && res.status !== 404) {
          console.warn(`Failed to destroy terminal session "${sessionId}" on explicit close: ${res.status}`);
        }
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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
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

  const addSessionTab = useCallback((label: string, sessionId: string, cwd = DEFAULT_CWD) => {
    const id = genId();
    const paneId = genId();
    const tab: Tab = {
      id,
      label,
      paneTree: {
        type: "pane",
        id: paneId,
        cwd,
        sessionId,
      },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    setFocusedPaneId(paneId);
    return id;
  }, []);

  const createShellSessionTab = useCallback(async (label: string, cwd = DEFAULT_CWD) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = `zellij-${genId()}`;
      try {
        const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, cwd }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 409) {
          continue;
        }
        if (!res.ok) {
          console.warn(`Failed to create shell session "${name}": ${res.status}`);
          return null;
        }
        if (!mountedRef.current) {
          destroyTerminalSessions([name]);
          return null;
        }
        addSessionTab(label, name, cwd);
        return name;
      } catch (err: unknown) {
        console.warn(
          "Failed to create shell session:",
          err instanceof Error ? err.message : String(err),
        );
        if (err instanceof Error && err.name === "AbortError") {
          continue;
        }
        return null;
      }
    }
    console.warn("Failed to create shell session: name collision");
    return null;
  }, [addSessionTab, destroyTerminalSessions]);

  useEffect(() => {
    let cancelled = false;

    async function initLayout() {
      if (initialCommand) {
        addTab(DEFAULT_CWD, initialLabel ?? "Terminal", initialClaudeMode, initialCommand);
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
            if (layoutUsesOnlyCanonicalShellSessions(data)) {
              const nextActiveTabId = data.activeTabId ?? data.tabs[0].id;
              const nextActiveTab = data.tabs.find((tab) => tab.id === nextActiveTabId) ?? data.tabs[0];
              setTabs(data.tabs);
              setActiveTabId(nextActiveTabId);
              setSidebarOpen(initialMobileRef.current ? false : data.sidebarOpen ?? true);
              setFocusedPaneId(nextActiveTab ? getFirstPaneId(nextActiveTab.paneTree) : null);
              setInitialized(true);
              return;
            }

            const sessionReady = await ensureDefaultShellSession();
            if (!cancelled && sessionReady) {
              addSessionTab(DEFAULT_SHELL_SESSION_NAME, DEFAULT_SHELL_SESSION_NAME);
              setInitialized(true);
              return;
            }
          }
        }
      } catch (err: unknown) {
        console.warn("Failed to load terminal layout:", err instanceof Error ? err.message : err);
      }

      if (!cancelled) {
        const sessionReady = await ensureDefaultShellSession();
        if (!cancelled) {
          if (sessionReady) {
            addSessionTab(DEFAULT_SHELL_SESSION_NAME, DEFAULT_SHELL_SESSION_NAME);
          } else {
            addTab(DEFAULT_CWD);
          }
          setInitialized(true);
        }
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

    const drainLaunches = (event?: Event) => {
      const eventTargetId = event instanceof CustomEvent ? event.detail?.targetId : undefined;
      if (typeof eventTargetId === "string" && eventTargetId !== launchTargetId) return;
      for (const launch of drainTerminalLaunchQueue(launchTargetId)) {
        addTab(DEFAULT_CWD, launch.label, launch.claudeMode, launch.command);
      }
    };

    drainLaunches();
    window.addEventListener(TERMINAL_LAUNCH_EVENT, drainLaunches);
    return () => window.removeEventListener(TERMINAL_LAUNCH_EVENT, drainLaunches);
  }, [addTab, initialized, launchTargetId]);

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
      case "Z": e.preventDefault(); void createShellSessionTab("Zellij", getCwd()); break;
    }
  }, [addTab, closePane, createShellSessionTab, splitPane, focusedPaneId, getCwd]);

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Construct store-compatible interface for child components
  const storeApi = {
    tabs, activeTabId, sidebarOpen, sidebarSelectedPath, focusedPaneId, mobile,
    addTab, addSessionTab, createShellSessionTab, closeTab, setActiveTab: setActiveTabId, renameTab, reorderTabs,
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
        <LocalTerminalTabBar defaultCwd={DEFAULT_CWD} />
        <div className="flex flex-1 min-h-0">
          {!mobile && <LocalTerminalSidebar />}
          {activeTab ? (
            <div
              className="flex-1 min-w-0 min-h-0 flex"
              style={{ padding: mobile ? "6px" : "8px 10px 8px 12px", background: terminalBackground }}
            >
              <div className="flex flex-1 min-h-0 min-w-0 flex-col">
                <PaneGrid
                  paneTree={activeTab.paneTree}
                  theme={theme}
                  focusedPaneId={focusedPaneId}
                  onFocusPane={setFocusedPaneId}
                  onSessionAttached={handleSessionAttached}
                  shouldCachePane={shouldCachePane}
                  shouldDestroyPane={shouldDestroyPane}
                />
                {mobile && (
                  <TerminalKeyBar
                    onSend={(data) => dispatchPaneInput(focusedPaneId, data)}
                  />
                )}
              </div>
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
  mobile: boolean;
  addTab: (cwd: string, label?: string, claude?: boolean, startupCommand?: string) => string;
  addSessionTab: (label: string, sessionId: string, cwd?: string) => string;
  createShellSessionTab: (label: string, cwd?: string) => Promise<string | null>;
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
  const ctx = useTerminalAppContext();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeTabId);
  const focusedPaneId = ctx.focusedPaneId ?? (activeTab ? getFirstPaneId(activeTab.paneTree) : null);
  const sessionName = activeTab && focusedPaneId
    ? getSafePreferencesSessionName(getPaneSessionId(activeTab.paneTree, focusedPaneId))
    : null;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: "relative" }}>
      <ToolbarBtn onClick={() => setOpen((o) => !o)} title="Terminal preferences">
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
            padding: 0,
            minWidth: 260,
          }}
        >
          <TerminalPreferencesPanel sessionName={sessionName} />
        </div>
      )}
    </div>
  );
}

function LocalTerminalTabBar({ defaultCwd }: { defaultCwd: string }) {
  const ctx = useTerminalAppContext();
  const dragIndexRef = useRef<number | null>(null);

  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeTabId);
  const activePaneId = activeTab ? ctx.focusedPaneId ?? getFirstPaneId(activeTab.paneTree) : null;
  const activeCwd = activeTab && activePaneId
    ? getPaneCwd(activeTab.paneTree, activePaneId) ?? defaultCwd
    : defaultCwd;

  return (
    <div
      className="grid items-stretch border-b shrink-0 select-none"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
        height: ctx.mobile ? 50 : 44,
        padding: "4px 6px",
        gap: 4,
        gridTemplateColumns: ctx.mobile ? "1fr auto" : "minmax(0, 1fr) auto",
        minWidth: 0,
      }}
    >
      <div
        className="flex items-stretch overflow-x-auto min-w-0"
        style={{
          gap: 3,
          scrollbarWidth: "thin",
          overscrollBehaviorX: "contain",
        }}
      >
        {ctx.tabs.map((tab, i) => {
          const active = tab.id === ctx.activeTabId;
          const tabPaneId = getFirstPaneId(tab.paneTree);
          const tabSessionId = getPaneSessionId(tab.paneTree, tabPaneId);
          return (
            <div
              key={tab.id}
              className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
              style={{
                background: active ? "var(--background)" : "transparent",
                color: active ? "var(--foreground)" : "var(--muted-foreground)",
                border: `1px solid ${active ? "var(--border)" : "transparent"}`,
                borderRadius: 6,
                padding: ctx.mobile ? "0 8px" : "0 10px",
                fontSize: 12,
                height: ctx.mobile ? 34 : 34,
                fontWeight: active ? 500 : 400,
                minWidth: ctx.mobile ? 112 : 136,
                maxWidth: ctx.mobile ? 168 : 220,
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
              <span
                className="flex min-w-0 flex-col leading-tight"
                style={{ overflow: "hidden" }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{tab.label}</span>
                {(ctx.mobile || active) && (
                  <span
                    style={{
                      color: "var(--muted-foreground)",
                      fontSize: 10,
                      fontWeight: 400,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      fontFamily: "var(--font-mono, ui-monospace, monospace)",
                    }}
                  >
                    {active ? formatCwd(activeCwd) : tabSessionId ?? formatCwd(getPaneCwd(tab.paneTree, tabPaneId) ?? defaultCwd)}
                  </span>
                )}
              </span>
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
      <div
        className="flex items-center shrink-0"
        style={{
          gap: 4,
          paddingLeft: 8,
          borderLeft: "1px solid var(--border)",
          minWidth: 0,
        }}
      >
        {ctx.mobile ? (
          <ToolbarBtn
            onClick={() => ctx.addTab(getCwd())}
            title="New tab (Ctrl+Shift+T)"
          >
            <IconPlus />
          </ToolbarBtn>
        ) : (
          <>
            <ToolbarBtn
              onClick={() => ctx.addTab(getCwd(), "Claude Code", true)}
              title="Launch Claude Code (Ctrl+Shift+C)"
              variant="success"
            >
              Claude
            </ToolbarBtn>
            <ToolbarBtn
              onClick={() => { void ctx.createShellSessionTab("Zellij", getCwd()); }}
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
          </>
        )}
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

type SidebarTab = "projects" | "shells" | "sessions" | "files";

interface ShellSessionSummary {
  name: string;
  status?: "active" | "exited";
  updatedAt?: string;
  attachedClients?: number;
  tabs?: Array<{ idx: number; name?: string; focused?: boolean }>;
}

interface WorkspaceSessionSummary {
  id: string;
  kind?: "shell" | "agent";
  projectSlug?: string;
  taskId?: string;
  worktreeId?: string;
  pr?: number;
  agent?: "claude" | "codex" | "opencode" | "pi";
  runtime?: {
    status?: string;
  };
  status?: string;
  nativeAttachCommand?: string[];
  transcriptPath?: string;
}

function LocalTerminalSidebar() {
  const ctx = useTerminalAppContext();
  const [tab, setTab] = useState<SidebarTab>("projects");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellSessionSummary[]>([]);
  const [shellsLoading, setShellsLoading] = useState(false);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState("projects");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [filter, setFilter] = useState("");

  const selectSidebarTab = useCallback((nextTab: SidebarTab) => {
    setTab(nextTab);
    setFilter("");
  }, []);

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

  const fetchShells = useCallback(async () => {
    setShellsLoading(true);
    setShellsError(null);
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to load shells");
        setShells([]);
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      setShells(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (err: unknown) {
      console.warn("Failed to load shell sessions:", err instanceof Error ? err.message : err);
      setShellsError("Could not reach gateway");
      setShells([]);
    } finally {
      setShellsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "shells") void fetchShells();
  }, [fetchShells, tab]);

  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions?limit=100`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to load sessions");
        setSessions([]);
        return;
      }
      const data = (await res.json()) as { sessions?: WorkspaceSessionSummary[] };
      setSessions(Array.isArray(data.sessions) ? data.sessions : []);
    } catch (err: unknown) {
      console.warn("Failed to load workspace sessions:", err instanceof Error ? err.message : err);
      setSessionsError("Could not reach gateway");
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "sessions") void fetchSessions();
  }, [fetchSessions, tab]);

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
      <div className="flex flex-col items-center py-2 gap-2 shrink-0" style={{ width: 44, background: "var(--card)", borderRight: "1px solid var(--border)" }}>
        <button
          className="flex items-center justify-center rounded cursor-pointer hover:bg-[var(--accent)] transition-colors"
          style={{ width: 30, height: 30, fontSize: 14 }}
          onClick={() => ctx.setSidebarOpen(true)}
          title="Open sidebar (Ctrl+Shift+B)"
        >
          <PanelLeftOpenIcon size={16} strokeWidth={1.8} />
        </button>
      </div>
    );
  }

  const isAtRoot = !rootPath || rootPath === ".";
  const filteredProjects = filter
    ? projects.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : projects;
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredShells = normalizedFilter
    ? shells.filter((shell) => [
      shell.name,
      shell.status,
      shell.tabs?.map((shellTab) => shellTab.name).join(" "),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : shells;
  const filteredSessions = normalizedFilter
    ? sessions.filter((session) => [
      session.id,
      session.projectSlug,
      session.taskId,
      session.worktreeId,
      session.agent,
      session.runtime?.status,
      session.status,
      session.transcriptPath,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : sessions;

  const createManagedShell = async () => {
    const name = await ctx.createShellSessionTab("Zellij", ctx.sidebarSelectedPath ?? DEFAULT_CWD);
    if (name) {
      await fetchShells();
    } else {
      setShellsError("Failed to create shell");
    }
  };

  const deleteManagedShell = async (name: string) => {
    setShellsError(null);
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(name)}?force=1`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to remove shell");
        return;
      }
      await fetchShells();
    } catch (err: unknown) {
      console.warn("Failed to remove shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not remove shell");
    }
  };

  const openWorkspaceTransport = async (session: WorkspaceSessionSummary, mode: "observe" | "takeover") => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(session.id)}/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to attach session");
        return;
      }
      const data = (await res.json()) as { terminalSessionId?: string };
      if (data.terminalSessionId) {
        ctx.addSessionTab(`${session.id} · ${mode}`, data.terminalSessionId);
      }
    } catch (err: unknown) {
      console.warn("Failed to attach workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not attach session");
    }
  };

  const duplicateWorkspaceSession = async (session: WorkspaceSessionSummary) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: session.kind ?? (session.agent ? "agent" : "shell"),
          ...(session.agent ? { agent: session.agent } : {}),
          ...(session.projectSlug ? { projectSlug: session.projectSlug } : {}),
          ...(session.taskId ? { taskId: session.taskId } : {}),
          ...(session.worktreeId ? { worktreeId: session.worktreeId } : {}),
          ...(session.pr ? { pr: session.pr } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to duplicate session");
        return;
      }
      await fetchSessions();
    } catch (err: unknown) {
      console.warn("Failed to duplicate workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not duplicate session");
    }
  };

  const killWorkspaceSession = async (sessionId: string) => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setSessionsError("Failed to kill session");
        return;
      }
      await fetchSessions();
    } catch (err: unknown) {
      console.warn("Failed to kill workspace session:", err instanceof Error ? err.message : err);
      setSessionsError("Could not kill session");
    }
  };

  return (
    <div
      className="grid shrink-0 overflow-hidden"
      style={{
        width: 320,
        gridTemplateColumns: "48px minmax(0, 1fr)",
        background: "var(--card)",
        borderRight: "1px solid var(--border)",
      }}
    >
      <div
        className="flex flex-col items-center py-2"
        style={{
          gap: 6,
          borderRight: "1px solid var(--border)",
          background: "color-mix(in srgb, var(--background) 62%, var(--card))",
        }}
      >
        <SidebarRailButton label="Projects" icon={<FolderIcon size={16} strokeWidth={1.8} />} active={tab === "projects"} onClick={() => selectSidebarTab("projects")} />
        <SidebarRailButton label="Shells" icon={<TerminalIcon size={16} strokeWidth={1.8} />} active={tab === "shells"} onClick={() => selectSidebarTab("shells")} />
        <SidebarRailButton label="Agents" icon={<BotIcon size={16} strokeWidth={1.8} />} active={tab === "sessions"} onClick={() => selectSidebarTab("sessions")} />
        <SidebarRailButton label="Files" icon={<FilesIcon size={16} strokeWidth={1.8} />} active={tab === "files"} onClick={() => selectSidebarTab("files")} />
        <div style={{ flex: 1 }} />
        <button
          className="flex items-center justify-center cursor-pointer transition-colors"
          style={{
            width: 32,
            height: 32,
            borderRadius: 6,
            border: "1px solid transparent",
            background: "transparent",
            color: "var(--muted-foreground)",
            fontSize: 14,
          }}
          onClick={() => ctx.setSidebarOpen(false)}
          title="Hide sidebar (Ctrl+Shift+B)"
        >
          <PanelLeftCloseIcon size={16} strokeWidth={1.8} />
        </button>
      </div>

      <div className="flex min-w-0 flex-col overflow-hidden">
        <div
          className="shrink-0"
          style={{
            padding: "10px 12px 8px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <div className="flex items-center justify-between gap-2" style={{ marginBottom: 8 }}>
            <div className="min-w-0">
              <div
                className="truncate"
                style={{
                  color: "var(--foreground)",
                  fontSize: 13,
                  fontWeight: 650,
                  lineHeight: 1.1,
                }}
              >
                {tab === "projects" ? "Projects" : tab === "shells" ? "Shells" : tab === "sessions" ? "Agents" : "Files"}
              </div>
              <div
                className="truncate"
                style={{
                  color: "var(--muted-foreground)",
                  fontSize: 10,
                  fontFamily: "var(--font-mono, ui-monospace, monospace)",
                  marginTop: 3,
                }}
              >
                {tab === "files" ? rootPath || "~" : ctx.sidebarSelectedPath ? formatCwd(ctx.sidebarSelectedPath) : "~/projects"}
              </div>
            </div>
            {tab === "shells" ? (
              <button
                onClick={() => void createManagedShell()}
                className="flex items-center gap-1.5 cursor-pointer"
                style={{
                  height: 28,
                  padding: "0 10px",
                  borderRadius: 6,
                  border: "1px solid transparent",
                  background: "var(--primary)",
                  color: "var(--primary-foreground)",
                  fontSize: 12,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                <PlusIcon size={13} strokeWidth={2} />
                New
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              aria-label={`Search ${tab === "sessions" ? "agents" : tab}`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={tab === "shells" ? "Find shell..." : tab === "sessions" ? "Find agent..." : tab === "files" ? "Find file..." : "Find project..."}
              className="min-w-0 flex-1 text-[11px] outline-none"
              style={{
                height: 28,
                background: "var(--background)",
                color: "var(--foreground)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "0 8px",
              }}
            />
            <button
              onClick={() => {
                if (tab === "projects") void fetchProjects();
                if (tab === "shells") void fetchShells();
                if (tab === "sessions") void fetchSessions();
                if (tab === "files") void fetchDir(rootPath).then((entries: TreeNode[]) => setTree(entries.map(e => ({ ...e, path: `${rootPath}/${e.name}` }))));
              }}
              className="flex items-center justify-center cursor-pointer hover:bg-[var(--accent)] transition-colors"
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "1px solid var(--border)",
                background: "var(--background)",
                color: "var(--muted-foreground)",
                fontSize: 12,
              }}
              title="Refresh"
            >
              <RefreshCwIcon size={13} strokeWidth={1.8} />
            </button>
          </div>
        </div>

        {tab === "projects" ? (
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
                onOpenZellij={() => { void ctx.createShellSessionTab(`${p.name} · zellij`, p.path); }}
                onSelect={() => ctx.setSidebarSelectedPath(p.path)}
                isSelected={ctx.sidebarSelectedPath === p.path}
              />
            ))}
          </div>
        ) : tab === "shells" ? (
          <div className="flex-1 overflow-y-auto py-1">
            {shellsLoading && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                Loading shells...
              </div>
            )}
            {!shellsLoading && shellsError && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--destructive)" }}>
                {shellsError}
              </div>
            )}
            {!shellsLoading && !shellsError && filteredShells.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                {filter ? "No shells match" : "No zellij shells"}
              </div>
            )}
            {!shellsLoading && filteredShells.map((shell) => (
              <ShellCard
                key={shell.name}
                shell={shell}
                onOpen={() => ctx.addSessionTab(shell.name, shell.name)}
                onDelete={() => void deleteManagedShell(shell.name)}
              />
            ))}
          </div>
        ) : tab === "sessions" ? (
          <div className="flex-1 overflow-y-auto py-1">
            {sessionsLoading && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                Loading sessions...
              </div>
            )}
            {!sessionsLoading && sessionsError && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--destructive)" }}>
                {sessionsError}
              </div>
            )}
            {!sessionsLoading && !sessionsError && filteredSessions.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                {filter ? "No sessions match" : "No coding sessions"}
              </div>
            )}
            {!sessionsLoading && filteredSessions.map((session) => (
              <SessionCard
                key={session.id}
                session={session}
                onObserve={() => void openWorkspaceTransport(session, "observe")}
                onTakeover={() => void openWorkspaceTransport(session, "takeover")}
                onDuplicate={() => void duplicateWorkspaceSession(session)}
                onKill={() => void killWorkspaceSession(session.id)}
              />
            ))}
          </div>
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
    </div>
  );
}

function SidebarRailButton({
  label,
  icon,
  active,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="flex items-center justify-center cursor-pointer transition-colors"
      style={{
        width: 34,
        height: 34,
        borderRadius: 8,
        border: `1px solid ${active ? "var(--border)" : "transparent"}`,
        background: active ? "var(--card)" : "transparent",
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
        fontSize: 12,
        fontWeight: 700,
        boxShadow: active ? "0 1px 0 rgba(0,0,0,0.08)" : "none",
      }}
      title={label}
    >
      {icon}
    </button>
  );
}

function ShellCard({
  shell,
  onOpen,
  onDelete,
}: {
  shell: ShellSessionSummary;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const tabs = shell.tabs ?? [];
  const focusedTab = tabs.find((tab) => tab.focused) ?? tabs[0];
  return (
    <div
      style={{
        margin: "5px 8px",
        padding: "9px 10px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--background)",
      }}
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 5 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: shell.status === "exited" ? "var(--muted-foreground)" : "var(--success)",
            flexShrink: 0,
          }}
        />
        <span
          className="min-w-0 flex-1 truncate"
          style={{
            color: "var(--foreground)",
            fontSize: 12,
            fontWeight: 650,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
          }}
        >
          {shell.name}
        </span>
        <span style={{ color: "var(--muted-foreground)", fontSize: 10 }}>
          {shell.attachedClients ?? 0}
        </span>
      </div>
      <div className="truncate" style={{ color: "var(--muted-foreground)", fontSize: 10, paddingLeft: 15 }}>
        {shell.status ?? "active"} · {tabs.length} zellij tab{tabs.length === 1 ? "" : "s"}
      </div>
      {focusedTab ? (
        <div
          className="truncate"
          style={{
            color: "var(--muted-foreground)",
            fontSize: 10,
            paddingLeft: 15,
            marginTop: 2,
            fontFamily: "var(--font-mono, ui-monospace, monospace)",
          }}
        >
          {focusedTab.idx}: {focusedTab.name ?? "tab"}
        </div>
      ) : null}
      <div className="flex items-center gap-1" style={{ marginTop: 8, paddingLeft: 15 }}>
        <SessionActionBtn label="Open" sessionId={shell.name} onClick={onOpen} />
        <SessionActionBtn label="Delete" sessionId={shell.name} onClick={onDelete} danger />
      </div>
    </div>
  );
}

function SessionCard({
  session,
  onObserve,
  onTakeover,
  onDuplicate,
  onKill,
}: {
  session: WorkspaceSessionSummary;
  onObserve: () => void;
  onTakeover: () => void;
  onDuplicate: () => void;
  onKill: () => void;
}) {
  const health = session.runtime?.status ?? session.status ?? "unknown";
  return (
    <div
      style={{
        margin: "3px 8px",
        padding: "8px 10px 6px",
        borderRadius: 6,
        border: "1px solid var(--border)",
        background: "var(--background)",
      }}
    >
      <div className="flex items-center gap-1.5" style={{ marginBottom: 4 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: health === "running" ? "var(--success)" : "var(--muted-foreground)",
            flexShrink: 0,
          }}
        />
        <span className="text-[12px] truncate flex-1" style={{ color: "var(--foreground)", fontWeight: 500 }}>
          {session.id}
        </span>
      </div>
      <div className="text-[10px] truncate" style={{ color: "var(--muted-foreground)", paddingLeft: 12 }}>
        {health} health
      </div>
      <div className="text-[10px] truncate" style={{ color: "var(--muted-foreground)", paddingLeft: 12 }}>
        {[session.projectSlug, session.taskId, session.agent ?? session.kind ?? "shell"].filter(Boolean).join(" · ")}
      </div>
      {session.nativeAttachCommand && (
        <div
          className="text-[10px] truncate"
          style={{ color: "var(--muted-foreground)", fontFamily: "var(--font-mono, ui-monospace, monospace)", paddingLeft: 12, marginTop: 4 }}
        >
          {session.nativeAttachCommand.join(" ")}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1" style={{ marginTop: 6, paddingLeft: 12 }}>
        <SessionActionBtn label="Observe" sessionId={session.id} onClick={onObserve} />
        <SessionActionBtn label="Take over" sessionId={session.id} onClick={onTakeover} />
        <SessionActionBtn label="Duplicate" sessionId={session.id} onClick={onDuplicate} />
        <SessionActionBtn label="Kill" sessionId={session.id} onClick={onKill} danger />
      </div>
    </div>
  );
}

function SessionActionBtn({
  label,
  sessionId,
  onClick,
  danger,
}: {
  label: string;
  sessionId: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      aria-label={`${label} ${sessionId}`}
      onClick={onClick}
      className="text-[10px] cursor-pointer transition-colors"
      style={{
        padding: "2px 6px",
        borderRadius: 3,
        background: danger ? "var(--destructive)" : "var(--card)",
        color: danger ? "white" : "var(--foreground)",
        border: danger ? "none" : "1px solid var(--border)",
      }}
    >
      {label}
    </button>
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
