"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent, type SetStateAction } from "react";
import { countPanes as countPanesFromStore, getAllPaneIds } from "@/stores/terminal-store";
import { PaneGrid } from "./PaneGrid";
import { useTheme } from "@/hooks/useTheme";
import { getGatewayUrl } from "@/lib/gateway";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { drainTerminalLaunchQueue, TERMINAL_LAUNCH_EVENT } from "@/lib/terminal-launch";
import { useTerminalSettings, type TerminalThemeId } from "@/stores/terminal-settings";
import { getTerminalThemePreset } from "./terminal-themes";
import { getTerminalAppChromeCssVars, getTerminalAppChromeTheme, getTerminalAppThemeOption } from "./terminal-app-chrome-theme";
import { TerminalAppContext, type TerminalWindowControls } from "./TerminalAppContext";
import { TerminalEmbeddedToolbar, TerminalWorkspaceChrome } from "./TerminalChrome";
import { MobileCommandComposer, MobileTerminalActions } from "./MobileTerminalControls";
import { DEFAULT_TERMINAL_SIDEBAR_WIDTH, LocalTerminalSidebar } from "./TerminalSidebar";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { isCanonicalShellSessionId } from "./terminal-session-id";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";
import { MOBILE_TERMINAL_INPUT_ACTIVE_EVENT, type MobileTerminalInputActiveDetail } from "./mobile-terminal-events";
import {
  DEFAULT_CWD,
  applyCompatModeToTabs,
  closePaneInTree,
  compatModeForShellSession,
  destroyTerminalSessions,
  getCanonicalShellSessionIds,
  getFirstPaneId,
  getPaneIdsForSession,
  getPaneSessionId,
  getSessionIds,
  genId,
  hasPaneId,
  layoutUsesOnlyCanonicalShellSessions,
  removeSessionFromPaneTree,
  renameSessionInTree,
  setPaneSessionId,
  splitPaneInTree,
  terminalSessionName,
  type Tab,
  type TerminalLayout,
} from "./terminal-layout";
import {
  DEFAULT_SHELL_SESSION_NAME,
  formatShellDisplayName,
} from "./TerminalSidebarItems";

export { TERMINAL_INPUT_EVENT };
export type { TerminalInputEventDetail };

function dispatchPaneInput(paneId: string | null, data: string): void {
  if (!paneId) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalInputEventDetail>(TERMINAL_INPUT_EVENT, {
      detail: { paneId, data, action: "input" },
    }),
  );
}

async function readShellErrorCode(res: Response): Promise<string | null> {
  try {
    const data = await res.clone().json() as { error?: { code?: unknown } };
    return typeof data.error?.code === "string" ? data.error.code : null;
  } catch (err: unknown) {
    console.warn("Failed to parse shell error response:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function isShellSessionExistsResponse(res: Response): Promise<boolean> {
  return res.status === 409 && await readShellErrorCode(res) === "session_exists";
}

async function ensureShellSessions(sessionNames: string[]): Promise<boolean> {
  const requestedNames = Array.from(new Set(
    sessionNames.filter((name) => isCanonicalShellSessionId(name)),
  ));
  if (requestedNames.length === 0) {
    return true;
  }

  try {
    const listRes = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
      signal: AbortSignal.timeout(10_000),
    });
    const existingNames = new Set<string>();
    if (listRes.ok) {
      const data = await listRes.json() as { sessions?: Array<{ name?: unknown }> };
      if (Array.isArray(data.sessions)) {
        for (const session of data.sessions) {
          if (typeof session.name === "string") {
            existingNames.add(session.name);
          }
        }
      }
    }

    for (const name of requestedNames) {
      if (existingNames.has(name)) {
        continue;
      }
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- ordered repair: each missing saved zellij session is recreated once before layout restore; these are user-visible session names, not a fan-out workload.
      const createRes = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cwd: DEFAULT_CWD }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!createRes.ok && createRes.status !== 409) {
        return false;
      }
    }

    return true;
  } catch (err: unknown) {
    console.warn("Failed to ensure terminal sessions:", err instanceof Error ? err.message : err);
    return false;
  }
}

async function ensureDefaultShellSession(): Promise<boolean> {
  return ensureShellSessions([DEFAULT_SHELL_SESSION_NAME]);
}

async function getFirstOrderedShellSessionName(): Promise<string | null> {
  try {
    const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return null;
    }
    const data = await res.json() as { sessions?: Array<{ name?: unknown; status?: unknown }> };
    if (!Array.isArray(data.sessions)) {
      return null;
    }
    for (const session of data.sessions) {
      if (typeof session.name === "string" && isCanonicalShellSessionId(session.name) && session.status !== "exited") {
        return session.name;
      }
    }
    return null;
  } catch (err: unknown) {
    console.warn("Failed to load ordered shell sessions:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function ensureInitialShellSession(): Promise<string | null> {
  const firstOrdered = await getFirstOrderedShellSessionName();
  if (firstOrdered) {
    return firstOrdered;
  }
  const sessionReady = await ensureDefaultShellSession();
  return sessionReady ? DEFAULT_SHELL_SESSION_NAME : null;
}

let globalShellThemePreferenceLoadStarted = false;

function loadGlobalShellThemePreference(setThemeId: (themeId: TerminalThemeId) => void): void {
  if (typeof fetch !== "function") {
    return;
  }
  if (globalShellThemePreferenceLoadStarted) {
    return;
  }
  globalShellThemePreferenceLoadStarted = true;
  void fetch(`${getGatewayUrl()}/api/terminal/preferences`, {
    signal: AbortSignal.timeout(10_000),
  })
    .then((res) => res.ok ? res.json() : null)
    .then((data: unknown) => {
      if (!data || typeof data !== "object" || !("preferences" in data)) {
        return;
      }
      const next = (data as { preferences?: { shellThemeId?: unknown } }).preferences?.shellThemeId;
      if (next === "dark" || next === "light" || next === "matrix") {
        setThemeId(next);
      }
    })
    .catch((err: unknown) => {
      globalShellThemePreferenceLoadStarted = false;
      console.warn("Failed to load shell theme preferences:", err instanceof Error ? err.message : err);
    });
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
  windowControls?: TerminalWindowControls;
  /**
   * Render without the terminal's own dark title bar (traffic lights +
   * breadcrumb), because the host window already supplies a generic window.
   * Desktop terminal chrome is intentionally suppressed; mobile keeps a small
   * drawer toggle bar for usability.
   */
  embeddedChrome?: boolean;
  /**
   * CSS transform scale applied to the canvas ancestor. Forwarded to each
   * TerminalPane so its pointer-event correction can unscale xterm's
   * mouse-to-cell mapping. Defaults to 1 (no correction needed).
   */
  canvasZoom?: number;
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive core terminal shell component; extraction tracked separately. prefer-useReducer: the 6 useState fields are independent, not one related cluster: tabs/activeTabId/focusedPaneId are mutated through many distinct code paths (split, close, rename, reorder, session-attach) using nested functional updaters that read prev and call sibling setters, while sidebarOpen/sidebarSelectedPath are sidebar UI and initialized is a one-time bootstrap gate; a single reducer would not be a mechanical, behavior-identical change.
export function TerminalApp({ initialCommand, initialLabel, initialClaudeMode = false, initialSessionId, launchTargetId, mobile = false, windowControls, embeddedChrome = false, canvasZoom = 1 }: TerminalAppProps = {}) {
  const theme = useTheme();
  const themeId = useTerminalSettings((s) => s.themeId);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const appThemeId = useTerminalSettings((s) => s.appThemeId);
  const appThemeOption = getTerminalAppThemeOption(appThemeId);
  const appChromeTheme = getTerminalAppChromeTheme(appThemeOption.id);
  const appChromeCssVars = getTerminalAppChromeCssVars(appChromeTheme);

  // Keep terminal content aligned with the active shell theme. App chrome is
  // intentionally terminal-scoped and uses the separate app theme below.
  const terminalPreset = themeId === "system" ? null : getTerminalThemePreset(themeId);
  const terminalContentBackground =
    themeId === "system"
      ? (theme.colors.background || "var(--background)")
      : terminalPreset?.background ?? "var(--background)";
  const terminalChromeBackground = appChromeTheme.chromeBackground;
  const terminalChromeForeground = appChromeTheme.chromeForeground;
  const terminalChromeAccent = mobile ? "var(--terminal-mobile-primary-bg)" : appChromeTheme.chromeAccent;

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_TERMINAL_SIDEBAR_WIDTH);
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [mobileInputActive, setMobileInputActive] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<Tab[]>(tabs);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of `tabs`, read synchronously inside stable callbacks/effects that must not re-subscribe when tabs change; writing in render keeps the mirror current
  tabsRef.current = tabs;
  const activeTabIdRef = useRef(activeTabId);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of `activeTabId`, read synchronously inside stable callbacks/effects that must not re-subscribe when the active tab changes
  activeTabIdRef.current = activeTabId;
  const initialMobileRef = useRef(mobile);
  const sidebarOpenRef = useRef(sidebarOpen);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of `sidebarOpen`, read synchronously inside the layout-persistence callback that must not re-subscribe when the sidebar toggles
  sidebarOpenRef.current = sidebarOpen;
  const mountedRef = useRef(false);
  const pendingPaneSessionsRef = useRef<Map<string, string> | null>(null);
  if (pendingPaneSessionsRef.current === null) pendingPaneSessionsRef.current = new Map();
  const closingPaneIdsRef = useRef<Set<string> | null>(null);
  if (closingPaneIdsRef.current === null) closingPaneIdsRef.current = new Set();
  const layoutSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const terminalLayoutHydratedRef = useRef(false);
  const terminalLayoutDirtyRef = useRef(false);
  const markTerminalLayoutDirty = () => {
    terminalLayoutDirtyRef.current = true;
  };
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `log` is consumed in the dependency array of the tabs-changed useEffect below; removing the memo would re-create it every render and re-run that effect.
  const log = useCallback((event: string, details: Record<string, unknown> = {}) => {
    terminalAppDebug(event, {
      activeTabId: activeTabIdRef.current,
      focusedPaneId,
      tabIds: tabsRef.current.map((tab) => tab.id),
      ...details,
    });
  }, [focusedPaneId]);

  const mobileTerminalInputId = launchTargetId ?? "mobile-terminal";

  useEffect(() => {
    if (!mobile) return;
    const detail: MobileTerminalInputActiveDetail = {
      active: mobileInputActive,
      terminalId: mobileTerminalInputId,
    };
    window.dispatchEvent(new CustomEvent(MOBILE_TERMINAL_INPUT_ACTIVE_EVENT, { detail }));
  }, [mobile, mobileInputActive, mobileTerminalInputId]);

  useEffect(() => {
    if (!mobile) return;
    return () => {
      window.dispatchEvent(new CustomEvent(MOBILE_TERMINAL_INPUT_ACTIVE_EVENT, {
        detail: { active: false, terminalId: mobileTerminalInputId } satisfies MobileTerminalInputActiveDetail,
      }));
    };
  }, [mobile, mobileTerminalInputId]);

  const persistLayoutNow = () => {
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
  };

  const getPendingSessionIds = (paneIds: string[]) => {
    const seen = new Set<string>();
    for (const paneId of paneIds) {
      const sessionId = pendingPaneSessionsRef.current!.get(paneId);
      if (sessionId) {
        seen.add(sessionId);
      }
    }
    return Array.from(seen);
  };

  const markPanesClosing = (paneIds: string[]) => {
    for (const paneId of paneIds) {
      closingPaneIdsRef.current!.add(paneId);
    }
    setTimeout(() => {
      for (const paneId of paneIds) {
        closingPaneIdsRef.current!.delete(paneId);
      }
    }, 0);
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    loadGlobalShellThemePreference(setThemeId);
  }, [setThemeId]);

  const addTab = (cwd: string, label?: string, claude?: boolean, startupCommand?: string, sessionId?: string) => {
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
        compatMode: compatModeForShellSession(sessionId) ?? (startupCommand === "codex" ? "codex-tui" : undefined),
      },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    setFocusedPaneId(paneId);
    return id;
  };

  const addSessionTab = (label: string, sessionId: string, cwd = DEFAULT_CWD) => {
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
        compatMode: compatModeForShellSession(sessionId),
      },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    setFocusedPaneId(paneId);
    return id;
  };

  const createShellSessionTab = async (
    label: string,
    cwd = DEFAULT_CWD,
    options: { namePrefix?: string; cmd?: string } = {},
  ) => {
    let requestedCwd = cwd || "~";
    let retriedHomeCwd = false;
    const twoWordCollisionRetries = 3;
    const maxAttempts = options.namePrefix ? 3 : twoWordCollisionRetries + 1;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const name = terminalSessionName(options.namePrefix, {
        collisionFallback: !options.namePrefix && attempt >= twoWordCollisionRetries,
      });
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential-by-design retry loop: each attempt only runs if the prior one failed with a 409 name collision or abort; parallelizing would create multiple sessions
        const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, cwd: requestedCwd, ...(options.cmd ? { cmd: options.cmd } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (await isShellSessionExistsResponse(res)) {
          continue;
        }
        if (!res.ok) {
          if (!retriedHomeCwd && res.status === 400 && await readShellErrorCode(res) === "invalid_cwd") {
            retriedHomeCwd = true;
            requestedCwd = "~";
            attempt -= 1;
            continue;
          }
          console.warn(`Failed to create shell session "${name}": ${res.status}`);
          return null;
        }
        if (!mountedRef.current) {
          destroyTerminalSessions([name]);
          return null;
        }
        const data = await res.json() as { name?: unknown };
        const sessionName = typeof data.name === "string" ? data.name : name;
        addSessionTab(label, sessionName, requestedCwd);
        return sessionName;
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
  };

  const backgroundShellSession = (sessionId: string) => {
    const next = tabs.filter((tab) => !getSessionIds(tab.paneTree).includes(sessionId));
    const nextActiveTabId = next.some((tab) => tab.id === activeTabId) ? activeTabId : next[0]?.id ?? "";
    const nextFocusedPaneId =
      focusedPaneId && next.some((tab) => hasPaneId(tab.paneTree, focusedPaneId))
        ? focusedPaneId
        : next[0]
          ? getFirstPaneId(next[0].paneTree)
          : null;

    setTabs(next);
    setActiveTabId(nextActiveTabId);
    setFocusedPaneId(nextFocusedPaneId);
  };

  const removeDeletedShellSessionFromLayout = (sessionId: string) => {
    const paneIds = tabsRef.current.flatMap((tab) => getPaneIdsForSession(tab.paneTree, sessionId));
    if (paneIds.length === 0) {
      return;
    }
    markPanesClosing(paneIds);
    setTabs((prev) => {
      const next = prev
        .map((tab) => {
          const paneTree = removeSessionFromPaneTree(tab.paneTree, sessionId);
          return paneTree ? { ...tab, paneTree } : null;
        })
        .filter((tab): tab is Tab => tab !== null);
      tabsRef.current = next;
      setActiveTabId((current) => next.some((tab) => tab.id === current) ? current : next[0]?.id ?? "");
      setFocusedPaneId((current) => {
        if (current && next.some((tab) => hasPaneId(tab.paneTree, current))) {
          return current;
        }
        return next[0] ? getFirstPaneId(next[0].paneTree) : null;
      });
      return next;
    });
  };

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- one-time mount bootstrap that loads the saved terminal layout from the gateway; the fetch is AbortSignal-guarded and every state write is gated behind a `cancelled` flag cleared in cleanup, so this is an intentional mount-driven load, not render data
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
              const sessionReady = await ensureShellSessions(getCanonicalShellSessionIds(data));
              if (!cancelled && sessionReady) {
                const nextActiveTabId = data.activeTabId ?? data.tabs[0].id;
                const nextActiveTab = data.tabs.find((tab) => tab.id === nextActiveTabId) ?? data.tabs[0];
                setTabs(applyCompatModeToTabs(data.tabs));
                setActiveTabId(nextActiveTabId);
                setSidebarOpen(initialMobileRef.current ? false : data.sidebarOpen ?? true);
                setFocusedPaneId(nextActiveTab ? getFirstPaneId(nextActiveTab.paneTree) : null);
                setInitialized(true);
                return;
              }
            }

            const sessionName = await ensureInitialShellSession();
            if (!cancelled && sessionName) {
              addSessionTab(formatShellDisplayName(sessionName), sessionName);
              setInitialized(true);
              return;
            }
          }
        }
      } catch (err: unknown) {
        console.warn("Failed to load terminal layout:", err instanceof Error ? err.message : err);
      }

      if (!cancelled) {
        const sessionName = await ensureInitialShellSession();
        if (!cancelled) {
          if (sessionName) {
            addSessionTab(formatShellDisplayName(sessionName), sessionName);
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
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- intentional run-once mount bootstrap: re-running on any prop/callback change would re-initialize tabs and clobber the user's live terminal layout. The props (initialCommand/initialLabel/initialClaudeMode/initialSessionId) are mount-time inputs and addTab/addSessionTab are stable.
  }, []);

  const drainLaunches = useEffectEvent((event?: Event) => {
    const eventTargetId = event instanceof CustomEvent ? event.detail?.targetId : undefined;
    if (typeof eventTargetId === "string" && eventTargetId !== launchTargetId) return;
    for (const launch of drainTerminalLaunchQueue(launchTargetId)) {
      addTab(DEFAULT_CWD, launch.label, launch.claudeMode, launch.command);
    }
  });

  useEffect(() => {
    if (!initialized) {
      return;
    }

    const handleLaunch = (event: Event) => drainLaunches(event);

    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- drains the external terminal-launch queue (module-level state populated by other shells) once it is ready; the resulting tabs are not derivable in render, so this is a legitimate external-source drain, not adjusted-from-props state
    drainLaunches();
    window.addEventListener(TERMINAL_LAUNCH_EVENT, handleLaunch);
    return () => window.removeEventListener(TERMINAL_LAUNCH_EVENT, handleLaunch);
  }, [initialized, launchTargetId]);

  const flushLayout = useEffectEvent(() => {
    void persistLayoutNow();
  });

  useEffect(() => {
    if (!initialized) {
      return;
    }

    if (!terminalLayoutHydratedRef.current) {
      terminalLayoutHydratedRef.current = true;
      if (!terminalLayoutDirtyRef.current) return;
    }
    terminalLayoutDirtyRef.current = true;

    if (layoutSaveTimerRef.current) {
      clearTimeout(layoutSaveTimerRef.current);
    }

    layoutSaveTimerRef.current = setTimeout(() => {
      layoutSaveTimerRef.current = null;
      flushLayout();
      terminalLayoutDirtyRef.current = false;
    }, 500);

    return () => {
      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }
    };
  }, [initialized, activeTabId, sidebarOpen, tabs]);

  useEffect(() => {
    const flushOnPageHide = () => {
      if (!initialized) {
        return;
      }
      if (!terminalLayoutDirtyRef.current) {
        return;
      }

      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }

      flushLayout();
      terminalLayoutDirtyRef.current = false;
    };

    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
    };
  }, [initialized]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // Read the live value via ref (not a dep) so the observer is created once.
    // Depending on `sidebarOpen` recreated the observer on every toggle, and a
    // fresh observe() fires an immediate callback that snapped a just-expanded
    // sidebar shut in a narrow terminal — making the expand/minimize toggle
    // appear broken. Now it only collapses on an actual narrow resize.
    const observer = new ResizeObserver((entries) => {
      if ((entries[0]?.contentRect.width ?? 0) < 500 && sidebarOpenRef.current) setSidebarOpen(false);
    });
    // react-doctor-disable-next-line react-doctor/no-initialize-state -- false positive: observing the container may synchronously deliver the current size, but it only closes an already-open sidebar when the measured terminal width is narrow
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const closeTab = (tabId: string) => {
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
  };

  const splitPane = (paneId: string, dir: "horizontal" | "vertical") => {
    setTabs(prev => prev.map(t => {
      if (t.id !== activeTabId || countPanes(t.paneTree) >= 4) return t;
      return { ...t, paneTree: splitPaneInTree(t.paneTree, paneId, dir) };
    }));
  };

  const closePane = (paneId: string) => {
    const activeTabRecord = tabsRef.current.find((tab) => tab.id === activeTabId);
    const closingSessionIds = new Set<string>();
    const closingSessionId = activeTabRecord ? getPaneSessionId(activeTabRecord.paneTree, paneId) : null;
    if (closingSessionId) closingSessionIds.add(closingSessionId);
    const pendingSessionId = pendingPaneSessionsRef.current!.get(paneId);
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
  };

  const renameTab = (tabId: string, label: string) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, label } : t));
  };

  const renameShellSession = (fromSessionId: string, toSessionId: string) => {
    setTabs(prev => {
      const nextTabs = prev.map((tab) => {
        const nextTree = renameSessionInTree(tab.paneTree, fromSessionId, toSessionId);
        const nextLabel =
          tab.label === fromSessionId || tab.label === formatShellDisplayName(fromSessionId)
            ? formatShellDisplayName(toSessionId)
            : tab.label;
        return nextTree === tab.paneTree && nextLabel === tab.label
          ? tab
          : { ...tab, label: nextLabel, paneTree: nextTree };
      });
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  };

  const reorderTabs = (from: number, to: number) => {
    setTabs(prev => {
      const arr = [...prev];
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return arr;
    });
  };

  const getCwd = () => sidebarSelectedPath ?? DEFAULT_CWD;

  const handleSessionAttached = (paneId: string, sessionId: string) => {
    log("session-attached", { paneId, sessionId });
    pendingPaneSessionsRef.current!.set(paneId, sessionId);
    setTabs((prev) => {
      const nextTabs = prev.map((tab) => {
        const nextTree = setPaneSessionId(tab.paneTree, paneId, sessionId);
        return nextTree === tab.paneTree ? tab : { ...tab, paneTree: nextTree };
      });
      tabsRef.current = nextTabs;
      return nextTabs;
    });
  };

  const shouldCachePane = (paneId: string) => {
    const keep = !closingPaneIdsRef.current!.has(paneId) && tabsRef.current.some((tab) => hasPaneId(tab.paneTree, paneId));
    log("should-cache-pane", {
      paneId,
      keep,
      tabs: tabsRef.current.map((tab) => ({
        tabId: tab.id,
        paneIds: getAllPaneIds(tab.paneTree),
      })),
    });
    return keep;
  };

  const shouldDestroyPane = (paneId: string) => {
    return closingPaneIdsRef.current!.has(paneId);
  };

  useEffect(() => {
    const livePaneIds = new Set<string>();
    for (const tab of tabs) {
      for (const paneId of getAllPaneIds(tab.paneTree)) {
        livePaneIds.add(paneId);
      }
    }
    for (const paneId of Array.from(pendingPaneSessionsRef.current!.keys())) {
      if (!livePaneIds.has(paneId)) {
        pendingPaneSessionsRef.current!.delete(paneId);
      }
    }

    log("tabs-changed", {
      tabs: tabs.map((tab) => ({
        tabId: tab.id,
        paneIds: getAllPaneIds(tab.paneTree),
      })),
    });
  }, [log, tabs]);

  useEffect(() => {
    if (!initialized) return undefined;
    const resizeTimer = window.setTimeout(() => {
      window.dispatchEvent(new Event("resize"));
    }, 220);
    return () => window.clearTimeout(resizeTimer);
  }, [activeTabId, initialized, sidebarOpen]);

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    switch (e.key.toUpperCase()) {
      case "T": e.preventDefault(); markTerminalLayoutDirty(); void createShellSessionTab("Shell", getCwd()); break;
      case "W": e.preventDefault(); if (focusedPaneId) { markTerminalLayoutDirty(); closePane(focusedPaneId); } break;
      case "D": e.preventDefault(); if (focusedPaneId) { markTerminalLayoutDirty(); splitPane(focusedPaneId, "horizontal"); } break;
      case "E": e.preventDefault(); if (focusedPaneId) { markTerminalLayoutDirty(); splitPane(focusedPaneId, "vertical"); } break;
      case "B": e.preventDefault(); markTerminalLayoutDirty(); setSidebarOpen(o => !o); break;
      case "C": e.preventDefault(); markTerminalLayoutDirty(); addTab(getCwd(), "Claude Code", true); break;
      case "Z": e.preventDefault(); markTerminalLayoutDirty(); void createShellSessionTab("Shell", getCwd()); break;
    }
  };

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Construct store-compatible interface for child components
  const storeApi = {
    tabs, activeTabId, sidebarOpen, sidebarWidth, sidebarSelectedPath, focusedPaneId, mobile, windowControls,
    terminalBackground: appChromeTheme.drawerBorder,
    addTab: (...args: Parameters<typeof addTab>) => {
      markTerminalLayoutDirty();
      return addTab(...args);
    },
    addSessionTab: (...args: Parameters<typeof addSessionTab>) => {
      markTerminalLayoutDirty();
      return addSessionTab(...args);
    },
    createShellSessionTab: (...args: Parameters<typeof createShellSessionTab>) => {
      markTerminalLayoutDirty();
      return createShellSessionTab(...args);
    },
    backgroundShellSession: (...args: Parameters<typeof backgroundShellSession>) => {
      markTerminalLayoutDirty();
      return backgroundShellSession(...args);
    },
    removeDeletedShellSessionFromLayout: (...args: Parameters<typeof removeDeletedShellSessionFromLayout>) => {
      markTerminalLayoutDirty();
      return removeDeletedShellSessionFromLayout(...args);
    },
    closeTab: (...args: Parameters<typeof closeTab>) => {
      markTerminalLayoutDirty();
      return closeTab(...args);
    },
    setActiveTab: (tabId: string) => {
      markTerminalLayoutDirty();
      setActiveTabId(tabId);
    },
    renameTab: (...args: Parameters<typeof renameTab>) => {
      markTerminalLayoutDirty();
      return renameTab(...args);
    },
    renameShellSession: (...args: Parameters<typeof renameShellSession>) => {
      markTerminalLayoutDirty();
      return renameShellSession(...args);
    },
    reorderTabs: (...args: Parameters<typeof reorderTabs>) => {
      markTerminalLayoutDirty();
      return reorderTabs(...args);
    },
    splitPane: (...args: Parameters<typeof splitPane>) => {
      markTerminalLayoutDirty();
      return splitPane(...args);
    },
    closePane: (...args: Parameters<typeof closePane>) => {
      markTerminalLayoutDirty();
      return closePane(...args);
    },
    setFocusedPane: (paneId: string | null) => {
      markTerminalLayoutDirty();
      setFocusedPaneId(paneId);
    },
    setSidebarOpen: (value: SetStateAction<boolean>) => {
      markTerminalLayoutDirty();
      setSidebarOpen(value);
    },
    setSidebarWidth,
    setSidebarSelectedPath,
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full"
      style={{
        ...appChromeCssVars,
        background: "var(--terminal-app-window-bg)",
        color: "var(--terminal-chrome-fg)",
      }}
      role="application"
      aria-label="Terminal"
      data-terminal-input-active={mobileInputActive ? "true" : "false"}
      onKeyDown={handleKeyDown}
    >
      <TerminalAppContext.Provider value={storeApi}>
        {mobile ? (embeddedChrome ? <TerminalEmbeddedToolbar /> : <TerminalWorkspaceChrome />) : null}
        <div
          className={mobile ? "relative flex flex-1 min-h-0 flex-col" : "relative flex flex-1 min-h-0"}
          style={{ background: "var(--terminal-app-body-bg)" }}
        >
          <LocalTerminalSidebar />
          {activeTab ? (
            <div
              data-testid="terminal-content-surface"
              className="flex-1 min-w-0 min-h-0 flex"
              style={{
                padding: 0,
                background: terminalContentBackground,
                minHeight: mobile ? 0 : undefined,
              }}
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
                  allowRemoteResize={!mobile}
                  suppressNativeKeyboard={mobile}
                  canvasZoom={canvasZoom}
                />
                {mobile && (
                  <>
                    <MobileTerminalActions
                      defaultCwd={DEFAULT_CWD}
                      background={terminalChromeBackground}
                      foreground={terminalChromeForeground}
                      accent={terminalChromeAccent}
                    />
                    <MobileCommandComposer
                      onSend={(data) => dispatchPaneInput(focusedPaneId, data)}
                      background={terminalChromeBackground}
                      foreground={terminalChromeForeground}
                      accent={terminalChromeAccent}
                      onFocusChange={setMobileInputActive}
                    />
                    <TerminalKeyBar
                      onSend={(data) => dispatchPaneInput(focusedPaneId, data)}
                      background={terminalChromeBackground}
                      foreground={terminalChromeForeground}
                      accent={terminalChromeAccent}
                      compactOnly={mobileInputActive}
                    />
                  </>
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
                  type="button"
                  className="text-xs px-3 py-1.5 rounded cursor-pointer"
                  style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
                  onClick={() => { void createShellSessionTab("Shell", DEFAULT_CWD); }}
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
