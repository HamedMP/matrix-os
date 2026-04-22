"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { type PaneNode, countPanes as countPanesFromStore, getAllPaneIds } from "@/stores/terminal-store";
import { PaneGrid } from "./PaneGrid";
import { useTheme } from "@/hooks/useTheme";
import { getGatewayUrl } from "@/lib/gateway";

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

function isTerminalDebugEnabled(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (window.localStorage.getItem("matrix-terminal-debug") === "1") {
      return true;
    }
  } catch (_err: unknown) {
    // Ignore storage access failures.
  }

  try {
    return new URLSearchParams(window.location.search).get("terminalDebug") === "1";
  } catch (_err: unknown) {
    return false;
  }
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
}

export function TerminalApp({ initialCommand }: TerminalAppProps = {}) {
  const theme = useTheme();

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

  const addTab = useCallback((cwd: string, label?: string, claude?: boolean) => {
    const id = genId();
    const paneId = genId();
    const basename = cwd.split("/").filter(Boolean).pop() ?? "~";
    const tab: Tab = { id, label: label ?? basename, paneTree: { type: "pane", id: paneId, cwd, claudeMode: claude } };
    setTabs(prev => [...prev, tab]);
    setActiveTabId(id);
    setFocusedPaneId(paneId);
    return id;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initLayout() {
      if (initialCommand) {
        addTab(DEFAULT_CWD, "Claude Code", true);
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
    }
  }, [addTab, closePane, splitPane, focusedPaneId, getCwd]);

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
        <LocalTerminalTabBar defaultCwd={DEFAULT_CWD} />
        <div className="flex flex-1 min-h-0">
          <LocalTerminalSidebar />
          {activeTab ? (
            <PaneGrid
              paneTree={activeTab.paneTree}
              theme={theme}
              focusedPaneId={focusedPaneId}
              onFocusPane={setFocusedPaneId}
              onSessionAttached={handleSessionAttached}
              shouldCachePane={shouldCachePane}
              shouldDestroyPane={shouldDestroyPane}
            />
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

import { createContext, useContext } from "react";

interface TerminalAppContextType {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  sidebarSelectedPath: string | null;
  focusedPaneId: string | null;
  addTab: (cwd: string, label?: string, claude?: boolean) => string;
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

function LocalTerminalTabBar({ defaultCwd }: { defaultCwd: string }) {
  const ctx = useTerminalAppContext();
  const dragIndexRef = useRef<number | null>(null);

  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;

  return (
    <div className="flex items-stretch border-b shrink-0 select-none" style={{ background: "var(--card)", borderColor: "var(--border)", height: 34 }}>
      <div className="flex items-stretch overflow-x-auto flex-1 min-w-0">
        {ctx.tabs.map((tab, i) => (
          <div
            key={tab.id}
            className="flex items-center gap-1.5 px-3 text-xs cursor-pointer whitespace-nowrap"
            style={{
              background: tab.id === ctx.activeTabId ? "var(--background)" : "transparent",
              borderRight: "1px solid var(--border)",
              borderTop: tab.id === ctx.activeTabId ? "2px solid var(--primary)" : "2px solid transparent",
              color: tab.id === ctx.activeTabId ? "var(--foreground)" : "var(--muted-foreground)",
            }}
            draggable
            onClick={() => ctx.setActiveTab(tab.id)}
            onDragStart={() => { dragIndexRef.current = i; }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); if (dragIndexRef.current !== null && dragIndexRef.current !== i) ctx.reorderTabs(dragIndexRef.current, i); dragIndexRef.current = null; }}
          >
            <span className="size-1.5 rounded-full" style={{ background: "var(--success)" }} />
            <span>{tab.label}</span>
            <button className="ml-1 opacity-40 hover:opacity-100" onClick={(e) => { e.stopPropagation(); ctx.closeTab(tab.id); }} style={{ color: "var(--muted-foreground)" }}>x</button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-1 px-2 shrink-0">
        <button className="text-xs cursor-pointer hover:opacity-80" style={{ background: "var(--success)", color: "white", borderRadius: 4, padding: "2px 8px" }} onClick={() => ctx.addTab(getCwd(), "Claude Code", true)} title="Launch Claude Code">Claude Code</button>
        <button className="text-xs cursor-pointer hover:opacity-80" style={{ color: "var(--muted-foreground)" }} onClick={() => { if (ctx.focusedPaneId) ctx.splitPane(ctx.focusedPaneId, "horizontal"); }} title="Split horizontal">&#8862;</button>
        <button className="text-xs cursor-pointer hover:opacity-80" style={{ color: "var(--muted-foreground)" }} onClick={() => { if (ctx.focusedPaneId) ctx.splitPane(ctx.focusedPaneId, "vertical"); }} title="Split vertical">&#8863;</button>
        <button className="text-xs cursor-pointer hover:opacity-80" style={{ color: "var(--muted-foreground)" }} onClick={() => ctx.addTab(getCwd())} title="New tab">+</button>
      </div>
    </div>
  );
}

function LocalTerminalSidebar() {
  const ctx = useTerminalAppContext();
  const [rootPath, setRootPath] = useState("projects");
  const [tree, setTree] = useState<TreeNode[]>([]);

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
    fetchDir(rootPath).then((entries: TreeNode[]) => setTree(entries.map(e => ({ ...e, path: `${rootPath}/${e.name}` }))));
  }, [rootPath, fetchDir]);

  const toggleExpand = useCallback(async (node: TreeNode) => {
    if (node.type !== "directory") return;
    if (node.expanded) { setTree(prev => updateNode(prev, node.path, { expanded: false })); return; }
    const children = await fetchDir(node.path);
    setTree(prev => updateNode(prev, node.path, { expanded: true, children: children.map((c: TreeNode) => ({ ...c, path: `${node.path}/${c.name}` })) }));
  }, [fetchDir]);

  if (!ctx.sidebarOpen) {
    return (
      <div className="flex flex-col items-center py-2 gap-2 shrink-0" style={{ width: 36, background: "var(--card)", borderRight: "1px solid var(--border)" }}>
        <button className="flex items-center justify-center rounded cursor-pointer hover:bg-[var(--accent)]" style={{ width: 24, height: 24, fontSize: 14 }} onClick={() => ctx.setSidebarOpen(true)} title="Files">&#128193;</button>
      </div>
    );
  }

  const isAtRoot = !rootPath || rootPath === ".";

  return (
    <div className="flex flex-col shrink-0 overflow-hidden" style={{ width: 200, background: "var(--card)", borderRight: "1px solid var(--border)" }}>
      <div className="flex items-center gap-1 px-2 py-1.5 text-[10px] shrink-0" style={{ borderBottom: "1px solid var(--border)" }}>
        <button className="flex items-center justify-center rounded cursor-pointer hover:bg-[var(--accent)]" style={{ width: 24, height: 24, fontSize: 14 }} onClick={() => ctx.setSidebarOpen(false)} title="Files">&#128193;</button>
        {!isAtRoot && <button className="text-xs opacity-60 hover:opacity-100 cursor-pointer" onClick={() => { const p = rootPath.split("/").filter(Boolean); p.pop(); setRootPath(p.join("/") || ""); }} style={{ color: "var(--muted-foreground)" }}>..</button>}
        <span className="text-[10px] truncate" style={{ color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.5px" }}>{rootPath || "~"}</span>
      </div>
      <div className="flex-1 overflow-y-auto py-1 text-xs">
        {tree.map(node => (
          <TreeItem key={node.path} node={node} depth={0} selectedPath={ctx.sidebarSelectedPath}
            onToggle={toggleExpand}
            onSelect={(n) => { if (n.type === "directory") ctx.setSidebarSelectedPath(n.path); }}
            onOpenTerminal={(path) => ctx.addTab(path)}
          />
        ))}
        {tree.length === 0 && <div className="px-3 py-4 text-center" style={{ color: "var(--muted-foreground)" }}>Empty directory</div>}
      </div>
    </div>
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
