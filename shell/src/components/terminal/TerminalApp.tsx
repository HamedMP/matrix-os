"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  ChevronsLeftIcon,
  ClipboardPasteIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
} from "lucide-react";
import { countPanes as countPanesFromStore, getAllPaneIds } from "@/stores/terminal-store";
import { PaneGrid } from "./PaneGrid";
import { useTheme } from "@/hooks/useTheme";
import { getGatewayUrl } from "@/lib/gateway";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { drainTerminalLaunchQueue, TERMINAL_LAUNCH_EVENT } from "@/lib/terminal-launch";
import { useTerminalSettings, type TerminalThemeId } from "@/stores/terminal-settings";
import { getTerminalThemePreset } from "./terminal-themes";
import { getTerminalAppChromeCssVars, getTerminalAppChromeTheme, getTerminalAppThemeOption } from "./terminal-app-chrome-theme";
import { TerminalAppContext, useTerminalAppContext, type TerminalWindowControls } from "./TerminalAppContext";
import { LocalTerminalTabBar, TerminalEmbeddedToolbar, TerminalWorkspaceChrome } from "./TerminalChrome";
import { ThemePickerButton } from "./TerminalThemePicker";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { isCanonicalShellSessionId } from "./terminal-session-id";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";
import { MOBILE_TERMINAL_INPUT_ACTIVE_EVENT, type MobileTerminalInputActiveDetail } from "./mobile-terminal-events";
import { NewSessionMenu } from "./NewSessionMenu";
import {
  DEFAULT_CWD,
  applyCompatModeToTabs,
  closePaneInTree,
  compatModeForShellSession,
  destroyTerminalSessions,
  formatCwd,
  getCanonicalShellSessionIds,
  getFirstPaneId,
  getPaneCwd,
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
  parseTerminalAgentStatuses,
  terminalAgentVisibleInstallCommand,
  type TerminalAgentId,
  type TerminalAgentOption,
} from "./terminal-agent-options";
import {
  applyShellRefreshFailure,
  applyShellRefreshSilentFailure,
  applyShellRefreshSuccess,
  applyShellUiStatePatch,
  rollbackShellUiStatePatch,
  shellSessionsEqual,
  snapshotShellUiStatePatch,
  type ShellRefreshState,
  type ShellSessionSummary,
  type ShellUiStatePatch,
} from "./terminal-session-state";
import {
  CollapsedSessionsRail,
  DEFAULT_SHELL_SESSION_NAME,
  ShellSessionGroup,
  filterTreeNodes,
  formatShellDisplayName,
  getShellStatusDotClassName,
  getShellStatusDotStyle,
  updateNode,
  type ProjectInfo,
  type TreeNode,
  type WorkspaceSessionSummary,
} from "./TerminalSidebarItems";

export { TERMINAL_INPUT_EVENT };
export type { TerminalInputEventDetail };

const SHELL_NEW_BUTTON_BASE_STYLE: CSSProperties = {
  height: 28,
  padding: "0 10px",
  borderRadius: 6,
  border: "1px solid transparent",
  background: "var(--primary)",
  color: "var(--primary-foreground)",
  fontSize: 12,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

const SHELLS_REFRESH_INTERVAL_MS = 5_000;
const SHELL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const DEFAULT_TERMINAL_SIDEBAR_WIDTH = 392;
const MIN_TERMINAL_SIDEBAR_WIDTH = 280;
const MAX_TERMINAL_SIDEBAR_WIDTH = 560;
const TERMINAL_SIDEBAR_TRANSITION = "opacity 140ms ease, transform 180ms ease";
const SHELL_STATUS_DOT_CSS = `
@keyframes terminal-session-status-pulse {
  0%, 100% { box-shadow: 0 0 0 4px rgba(95, 184, 95, 0.24); }
  50% { box-shadow: 0 0 0 6px rgba(95, 184, 95, 0.10); }
}
@keyframes terminal-refresh-spin {
  to { transform: rotate(360deg); }
}
.terminal-session-status-dot--running {
  animation: terminal-session-status-pulse 1.35s ease-in-out infinite;
}
.terminal-refresh-icon--loading {
  animation: terminal-refresh-spin 0.9s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .terminal-session-status-dot--running,
  .terminal-refresh-icon--loading {
    animation: none;
  }
}
`;

function dispatchPaneInput(paneId: string | null, data: string): void {
  if (!paneId) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalInputEventDetail>(TERMINAL_INPUT_EVENT, {
      detail: { paneId, data, action: "input" },
    }),
  );
}

function dispatchPaneAction(paneId: string | null, action: NonNullable<TerminalInputEventDetail["action"]>): void {
  if (!paneId) return;
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TerminalInputEventDetail>(TERMINAL_INPUT_EVENT, {
      detail: { paneId, action },
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

function clampTerminalSidebarWidth(width: number): number {
  return Math.min(MAX_TERMINAL_SIDEBAR_WIDTH, Math.max(MIN_TERMINAL_SIDEBAR_WIDTH, Math.round(width)));
}

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
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = terminalSessionName(options.namePrefix);
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential-by-design retry loop: each attempt only runs if the prior one failed with a 409 name collision or abort; parallelizing would create multiple sessions
        const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, cwd: requestedCwd, ...(options.cmd ? { cmd: options.cmd } : {}) }),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 409) {
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
    setSidebarOpen: (value: React.SetStateAction<boolean>) => {
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
      <style>{SHELL_STATUS_DOT_CSS}</style>
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

// ---- Local versions of TabBar and Sidebar that use context instead of global store ----

function MobileTerminalActions({
  defaultCwd,
  background,
  foreground,
  accent,
}: {
  defaultCwd: string;
  background: string;
  foreground: string;
  accent: string;
}) {
  const ctx = useTerminalAppContext();
  const [newSessionMenuOpen, setNewSessionMenuOpen] = useState(false);
  const [agentStatuses, setAgentStatuses] = useState<Record<TerminalAgentId, boolean> | null>(null);
  const newSessionDisclosureRef = useRef<HTMLDivElement | null>(null);
  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const focusedPaneId = ctx.focusedPaneId;
  const actionBackground = `color-mix(in srgb, ${foreground} 9%, transparent)`;
  const actionBorder = `color-mix(in srgb, ${foreground} 18%, transparent)`;
  const primaryForeground = "var(--terminal-mobile-primary-fg)";

  const fetchAgentStatuses = async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/agents`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const parsed = parseTerminalAgentStatuses(await res.json());
      if (parsed.length === 0) return;
      setAgentStatuses(Object.fromEntries(
        parsed.map((agent) => [agent.id, agent.installed]),
      ) as Record<TerminalAgentId, boolean>);
    } catch (err: unknown) {
      console.warn("Failed to load terminal agent status:", err instanceof Error ? err.message : String(err));
    }
  };

  const toggleNewSessionMenu = () => {
    const shouldOpen = !newSessionMenuOpen;
    setNewSessionMenuOpen(shouldOpen);
    if (shouldOpen) void fetchAgentStatuses();
  };

  const closeNewSessionMenu = () => {
    setNewSessionMenuOpen(false);
  };

  const createShellSession = () => {
    setNewSessionMenuOpen(false);
    void ctx.createShellSessionTab("Shell", getCwd());
  };

  const createAgentSession = (option: TerminalAgentOption, installed: boolean) => {
    setNewSessionMenuOpen(false);
    const label = installed ? option.label : `Install ${option.label}`;
    const cmd = installed
      ? option.launchCommand ?? (option.claudeMode ? "claude" : undefined)
      : terminalAgentVisibleInstallCommand(option);
    void ctx.createShellSessionTab(label, getCwd(), {
      namePrefix: option.id,
      cmd,
    });
  };

  return (
    <div
      data-testid="terminal-mobile-actions"
      role="toolbar"
      aria-label="Mobile terminal actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        overflow: "visible",
        padding: "6px 2px 4px",
        position: "relative",
        background,
        borderTop: `1px solid ${actionBorder}`,
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
        flexShrink: 0,
      }}
    >
      <div ref={newSessionDisclosureRef} style={{ position: "relative", flex: "0 0 auto" }}>
        <MobileActionButton
          label="+ Session"
          ariaLabel="New session"
          ariaHasPopup="menu"
          ariaExpanded={newSessionMenuOpen}
          title="New session"
          icon={<PlusIcon size={14} strokeWidth={1.8} />}
          onClick={toggleNewSessionMenu}
          background={accent}
          foreground={primaryForeground}
          border="transparent"
          minWidth={92}
        />
        {newSessionMenuOpen ? (
          <NewSessionMenu
            align="mobile"
            onClose={closeNewSessionMenu}
            onCreateShell={createShellSession}
            onCreateAgent={createAgentSession}
            agentStatuses={agentStatuses}
            ignoreLightDismissRef={newSessionDisclosureRef}
          />
        ) : null}
      </div>
      <MobileActionButton
        label="Paste"
        title="Paste clipboard"
        icon={<ClipboardPasteIcon size={14} strokeWidth={1.8} />}
        onClick={() => dispatchPaneAction(focusedPaneId, "paste")}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
        minWidth={62}
      />
      <MobileActionButton
        label="Search"
        title="Search terminal"
        icon={<SearchIcon size={14} strokeWidth={1.8} />}
        onClick={() => dispatchPaneAction(focusedPaneId, "search")}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
        minWidth={66}
      />
    </div>
  );
}

function MobileActionButton({
  label,
  ariaLabel,
  ariaHasPopup,
  ariaExpanded,
  title,
  icon,
  onClick,
  background,
  foreground,
  border,
  minWidth = 56,
}: {
  label: string;
  ariaLabel?: string;
  ariaHasPopup?: "menu";
  ariaExpanded?: boolean;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  background: string;
  foreground: string;
  border: string;
  minWidth?: number;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel ?? label}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      title={title}
      onClick={onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 4,
        height: 32,
        minWidth,
        padding: "0 5px",
        borderRadius: 7,
        border: `1px solid ${border}`,
        background,
        color: foreground,
        fontSize: 11,
        fontWeight: 650,
        whiteSpace: "nowrap",
        flex: "0 0 auto",
        touchAction: "manipulation",
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function MobileCommandComposer({
  onSend,
  background,
  foreground,
  accent,
  onFocusChange,
}: {
  onSend: (data: string) => void;
  background: string;
  foreground: string;
  accent: string;
  onFocusChange?: (active: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const command = value.trim();
    if (!command) return;
    onSend(`${command}\r`);
    setValue("");
  };
  const border = `color-mix(in srgb, ${foreground} 18%, transparent)`;
  return (
    <form
      aria-label="Mobile command composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      style={{
        alignItems: "center",
        background,
        borderTop: `1px solid ${border}`,
        display: "flex",
        flexShrink: 0,
        gap: 7,
        padding: "8px 7px",
      }}
    >
      <input
        aria-label="Command composer"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="Type command..."
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        enterKeyHint="send"
        spellCheck={false}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => onFocusChange?.(false)}
        style={{
          background: `color-mix(in srgb, ${foreground} 8%, transparent)`,
          border: `1px solid ${border}`,
          borderRadius: 9,
          color: foreground,
          flex: "1 1 auto",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 16,
          height: 36,
          minWidth: 0,
          padding: "0 10px",
        }}
      />
      <button
        type="submit"
        aria-label="Send command"
        style={{
          background: accent,
          border: "1px solid transparent",
          borderRadius: 9,
          color: "var(--terminal-mobile-primary-fg)",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 12,
          fontWeight: 800,
          height: 36,
          padding: "0 13px",
        }}
      >
        Send
      </button>
    </form>
  );
}

type SidebarTab = "projects" | "shells" | "sessions" | "files";
type NewSessionMenuAnchor = "drawer" | "rail";

function workspaceSessionsEqual(left: WorkspaceSessionSummary[], right: WorkspaceSessionSummary[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort((a, b) => a.id.localeCompare(b.id));
  const sortedRight = [...right].sort((a, b) => a.id.localeCompare(b.id));
  return sortedLeft.every((session, index) => {
    const next = sortedRight[index];
    return (
      next !== undefined &&
      session.id === next.id &&
      session.kind === next.kind &&
      session.projectSlug === next.projectSlug &&
      session.taskId === next.taskId &&
      session.worktreeId === next.worktreeId &&
      session.pr === next.pr &&
      session.agent === next.agent &&
      session.runtime?.status === next.runtime?.status &&
      session.status === next.status &&
      session.transcriptPath === next.transcriptPath &&
      (session.nativeAttachCommand ?? []).join("\u0000") === (next.nativeAttachCommand ?? []).join("\u0000")
    );
  });
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive core terminal sidebar component; extraction tracked separately. prefer-useReducer: the 16 useState fields are several independent clusters, not one related cluster: projects/shells/sessions/files each carry their own data+loading+error triplet with separate fetch lifecycles, plus orthogonal tab/filter/rootPath/tree/agent-status UI state; collapsing them into one reducer would obscure the independent update sites and would not be a mechanical, behavior-identical change.
function LocalTerminalSidebar() {
  const ctx = useTerminalAppContext();
  const [tab, setTab] = useState<SidebarTab>("shells");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellSessionSummary[]>([]);
  const [shellsAuthoritative, setShellsAuthoritative] = useState(false);
  const [shellsStale, setShellsStale] = useState(false);
  const [shellsLoading, setShellsLoading] = useState(false);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const shellRefreshStateRef = useRef<ShellRefreshState>({
    shells: [],
    authoritative: false,
    stale: false,
    error: null,
  });
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for `fetchShells` and shell-tab refresh effect dependencies in compiled and test/runtime surfaces.
  const commitShellRefreshState = useCallback((nextState: ShellRefreshState) => {
    shellRefreshStateRef.current = nextState;
    setShells(nextState.shells);
    setShellsAuthoritative(nextState.authoritative);
    setShellsStale(nextState.stale);
    setShellsError(nextState.error);
  }, []);
  useEffect(() => {
    shellRefreshStateRef.current = {
      shells,
      authoritative: shellsAuthoritative,
      stale: shellsStale,
      error: shellsError,
    };
  }, [shells, shellsAuthoritative, shellsError, shellsStale]);
  const creatingShellRef = useRef(false);
  const reorderSaveCountRef = useRef(0);
  const [creatingShell, setCreatingShell] = useState(false);
  const deletingShellsRef = useRef<Set<string> | null>(null);
  if (deletingShellsRef.current === null) deletingShellsRef.current = new Set();
  const [deletingShellNames, setDeletingShellNames] = useState<string[]>([]);
  const [closeConfirmationShell, setCloseConfirmationShell] = useState<ShellSessionSummary | null>(null);
  const [newSessionMenuAnchor, setNewSessionMenuAnchor] = useState<NewSessionMenuAnchor | null>(null);
  const [backgroundSessionsExpanded, setBackgroundSessionsExpanded] = useState(true);
  const [draggingShellName, setDraggingShellName] = useState<string | null>(null);
  const [dragOverShellName, setDragOverShellName] = useState<string | null>(null);
  const [draggingShellPlacement, setDraggingShellPlacement] = useState<"active" | "background" | null>(null);
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<Record<TerminalAgentId, boolean> | null>(null);
  const [rootPath, setRootPath] = useState("projects");
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [filter, setFilter] = useState("");

  const selectSidebarTab = (nextTab: SidebarTab) => {
    setTab(nextTab);
    setFilter("");
  };

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchProjects` is in the dependency array of the projects-tab useEffect below.
  const fetchProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
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
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the projects list when the Projects tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    if (tab === "projects") void fetchProjects();
  }, [tab, fetchProjects]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for mount-time agent status loading and explicit refresh from the new-session menu lifecycle.
  const fetchAgentStatuses = useCallback(async () => {
    try {
      const res = await fetch(`${getGatewayUrl()}/api/agents`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.warn(`Failed to load terminal agent status: ${res.status}`);
        return;
      }
      const parsed = parseTerminalAgentStatuses(await res.json());
      if (parsed.length === 0) return;
      setAgentStatuses(Object.fromEntries(
        parsed.map((agent) => [agent.id, agent.installed]),
      ) as Record<TerminalAgentId, boolean>);
    } catch (err: unknown) {
      console.warn("Failed to load terminal agent status:", err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-fetch-in-effect -- owner-scoped local gateway status probe; it is timeout-guarded and falls back to the Paper default menu state if unavailable.
    void fetchAgentStatuses();
  }, [fetchAgentStatuses]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchShells` is in the dependency array of the shells-tab load useEffect below and command handlers.
  const fetchShells = useCallback(async (options: { silent?: boolean; signal?: AbortSignal; preserveOrderDuringReorder?: boolean } = {}) => {
    const silent = options.silent === true;
    if (!silent) setShellsLoading(true);
    if (!silent) setShellsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions`, {
        signal: options.signal ?? AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (silent) {
          commitShellRefreshState(applyShellRefreshSilentFailure(shellRefreshStateRef.current));
        }
        if (!silent) {
          commitShellRefreshState(applyShellRefreshFailure(
            shellRefreshStateRef.current,
            "Failed to load shells",
          ));
        }
        return;
      }
      if (options.preserveOrderDuringReorder === true && reorderSaveCountRef.current > 0) {
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      const hasSessionList = Array.isArray(data.sessions);
      const nextShells = hasSessionList ? data.sessions! : [];
      commitShellRefreshState(applyShellRefreshSuccess(
        shellRefreshStateRef.current,
        nextShells,
        hasSessionList,
      ));
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (silent) {
        commitShellRefreshState(applyShellRefreshSilentFailure(shellRefreshStateRef.current));
        return;
      }
      console.warn("Failed to load shell sessions:", err instanceof Error ? err.message : err);
      commitShellRefreshState(applyShellRefreshFailure(
        shellRefreshStateRef.current,
        "Could not reach gateway",
      ));
    } finally {
      if (!silent) setShellsLoading(false);
    }
  }, [commitShellRefreshState]);

  useEffect(() => {
    if (tab !== "shells") return;
    const controller = new AbortController();
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the shell-session list when the Shells tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    void fetchShells({ signal: controller.signal });
    const refreshTimer = window.setInterval(() => {
      void fetchShells({ silent: true, signal: controller.signal, preserveOrderDuringReorder: true });
    }, SHELLS_REFRESH_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, [fetchShells, tab]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchSessions` is in the dependency array of the sessions-tab useEffect below.
  const fetchSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async load is correct as written
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
      const nextSessions = Array.isArray(data.sessions)
        ? data.sessions.filter((session) => typeof session.id === "string" && session.id.length > 0)
        : [];
      setSessions((prev) => workspaceSessionsEqual(prev, nextSessions) ? prev : nextSessions);
    } catch (err: unknown) {
      console.warn("Failed to load workspace sessions:", err instanceof Error ? err.message : err);
      setSessionsError("Could not reach gateway");
      setSessions([]);
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-event-handler -- async network load of the workspace-session list when the Sessions tab becomes active; `tab` is live derived state that can change from many sources (restore, programmatic nav, deep link), not a single DOM click handler, so the fetch belongs in the effect and cannot be hoisted to one parent handler
    if (tab === "sessions") void fetchSessions();
  }, [fetchSessions, tab]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `fetchDir` is in the dependency array of the files-tab useEffect below.
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

  const toggleExpand = async (node: TreeNode) => {
    if (node.type !== "directory") return;
    if (node.expanded) { setTree(prev => updateNode(prev, node.path, { expanded: false })); return; }
    const children = await fetchDir(node.path);
    setTree(prev => updateNode(prev, node.path, { expanded: true, children: children.map((c: TreeNode) => ({ ...c, path: `${node.path}/${c.name}` })) }));
  };

  const isAtRoot = !rootPath || rootPath === ".";
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredProjects = normalizedFilter
    ? projects.filter((p) => p.name.toLowerCase().includes(normalizedFilter))
    : projects;
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
  const filteredTree = normalizedFilter ? filterTreeNodes(tree, normalizedFilter) : tree;

  const createManagedShell = async () => {
    if (creatingShellRef.current) return;
    setNewSessionMenuAnchor(null);
    creatingShellRef.current = true;
    setCreatingShell(true);
    setShellsError(null);
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async create flow is correct as written
    try {
      const name = await ctx.createShellSessionTab("Shell", ctx.sidebarSelectedPath ?? DEFAULT_CWD);
      if (name) {
        await fetchShells();
      } else {
        setShellsError("Failed to create shell");
      }
    } catch (err: unknown) {
      console.warn("Failed to create shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not create shell");
    } finally {
      creatingShellRef.current = false;
      setCreatingShell(false);
    }
  };

  const deleteManagedShell = async (name: string) => {
    if (deletingShellsRef.current!.has(name)) return;
    deletingShellsRef.current!.add(name);
    setDeletingShellNames(Array.from(deletingShellsRef.current!));
    setShellsError(null);
    const previousShells = shells;
    const deletedShell = previousShells.find((shell) => shell.name === name);
    setShells((prev) => prev.filter((shell) => shell.name !== name));
    // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower the try/finally below into memoized form; the async delete flow is correct as written
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(name)}?force=1`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to remove shell");
        setShells((prev) => prev.some((shell) => shell.name === name) || !deletedShell ? prev : [...prev, deletedShell]);
        return;
      }
      ctx.removeDeletedShellSessionFromLayout(name);
      await fetchShells({ silent: true });
    } catch (err: unknown) {
      console.warn("Failed to remove shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not remove shell");
      setShells((prev) => prev.some((shell) => shell.name === name) || !deletedShell ? prev : [...prev, deletedShell]);
    } finally {
      deletingShellsRef.current!.delete(name);
      setDeletingShellNames(Array.from(deletingShellsRef.current!));
    }
  };

  const renameManagedShell = async (shell: ShellSessionSummary, nextNameRaw: string): Promise<boolean> => {
    const nextName = nextNameRaw.trim();
    if (nextName === shell.name) return true;
    if (!SHELL_SESSION_NAME_PATTERN.test(nextName)) {
      setShellsError("Use lowercase letters, numbers, and hyphens");
      return false;
    }
    setShellsError(null);
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(shell.name)}/rename`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nextName }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Failed to rename session");
        return false;
      }
      const data = (await res.json()) as { session?: ShellSessionSummary };
      const renamedShell: ShellSessionSummary = data.session?.name
        ? data.session
        : {
            ...shell,
            name: nextName,
            attachCommand: `mos shell attach ${nextName}`,
          };
      setShells((prev) => prev.map((item) => item.name === shell.name ? renamedShell : item));
      ctx.renameShellSession(shell.name, renamedShell.name);
      return true;
    } catch (err: unknown) {
      console.warn("Failed to rename shell session:", err instanceof Error ? err.message : err);
      setShellsError("Could not rename session");
      return false;
    }
  };

  const patchShellUiState = async (
    name: string,
    patch: ShellUiStatePatch,
    options: { rollbackOnFailure?: boolean } = {},
  ) => {
    const rollbackOnFailure = options.rollbackOnFailure ?? true;
    setShellsError(null);
    const previousValues: ShellUiStatePatch = {};
    setShells((prev) => prev.map((shell) => {
      if (shell.name !== name) return shell;
      Object.assign(previousValues, snapshotShellUiStatePatch(shell, patch));
      return applyShellUiStatePatch(shell, patch);
    }));
    const rollback = () => {
      setShells((prev) => prev.map((shell) => (
        shell.name === name
          ? rollbackShellUiStatePatch(shell, patch, previousValues)
          : shell
      )));
    };
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(name)}/ui-state`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        if (rollbackOnFailure) {
          setShellsError("Failed to update session");
          rollback();
        }
        return null;
      }
      const data = (await res.json()) as { session?: ShellSessionSummary };
      if (data.session?.name) {
        setShells((prev) => prev.map((shell) => shell.name === data.session!.name ? data.session! : shell));
        return data.session;
      }
      return null;
    } catch (err: unknown) {
      console.warn("Failed to update shell session UI state:", err instanceof Error ? err.message : err);
      if (rollbackOnFailure) {
        setShellsError("Could not update session");
        rollback();
      }
      return null;
    }
  };

  const openWorkspaceTransport = async (session: WorkspaceSessionSummary, mode: "observe" | "takeover") => {
    if (!session.id) {
      setSessionsError("Session is missing an id");
      return;
    }
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

  const openSessionIds = new Set<string>();
  const syntheticShells: ShellSessionSummary[] = [];
  for (const terminalTab of ctx.tabs) {
    for (const sessionId of getSessionIds(terminalTab.paneTree)) {
      if (!sessionId || openSessionIds.has(sessionId)) continue;
      openSessionIds.add(sessionId);
      if (!isCanonicalShellSessionId(sessionId)) continue;
      syntheticShells.push({
        name: sessionId,
        status: "active",
        placement: "active",
        attachedClients: 1,
        tabs: [{ idx: 0, name: "main", focused: true }],
      });
    }
  }
  const syntheticFilteredShells = normalizedFilter
    ? syntheticShells.filter((shell) => [
      shell.name,
      shell.status,
      shell.tabs?.map((shellTab) => shellTab.name).join(" "),
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter))
    : syntheticShells;
  const unfilteredRenderedShells = shells.length > 0
    ? shells
    : shellsAuthoritative ? [] : syntheticShells;
  const renderedShells = filteredShells.length > 0
    ? filteredShells
    : shellsAuthoritative ? [] : syntheticFilteredShells;
  const activeShells = renderedShells.filter((shell) => (shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")) === "active");
  const backgroundShells = renderedShells.filter((shell) => (shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")) === "background");
  const activeTerminalTab = ctx.tabs.find((terminalTab) => terminalTab.id === ctx.activeTabId) ?? ctx.tabs[0];
  const selectedPaneId = activeTerminalTab
    ? ctx.focusedPaneId && hasPaneId(activeTerminalTab.paneTree, ctx.focusedPaneId)
      ? ctx.focusedPaneId
      : getFirstPaneId(activeTerminalTab.paneTree)
    : null;
  const activePaneSessionId = activeTerminalTab && selectedPaneId
    ? getPaneSessionId(activeTerminalTab.paneTree, selectedPaneId)
    : null;
  const activeShellName = activePaneSessionId && isCanonicalShellSessionId(activePaneSessionId)
    ? activePaneSessionId
    : null;
  const drawerWidth = ctx.mobile ? "100%" : clampTerminalSidebarWidth(ctx.sidebarWidth);
  const startSidebarResize = (event: ReactPointerEvent<HTMLElement>) => {
    if (ctx.mobile) return;
    event.preventDefault();
    event.stopPropagation();
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    resizeHandle.setPointerCapture?.(pointerId);
    const startX = event.clientX;
    const startWidth = clampTerminalSidebarWidth(ctx.sidebarWidth);
    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      ctx.setSidebarWidth(clampTerminalSidebarWidth(startWidth + moveEvent.clientX - startX));
    };
    const finishResize = () => {
      if (resizeHandle.hasPointerCapture?.(pointerId)) {
        resizeHandle.releasePointerCapture?.(pointerId);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize, { once: true });
    window.addEventListener("pointercancel", finishResize, { once: true });
  };
  const resizeSidebarWithKeyboard = (event: KeyboardEvent<HTMLElement>) => {
    if (ctx.mobile) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -16 : 16;
    ctx.setSidebarWidth((width) => clampTerminalSidebarWidth(width + delta));
  };
  const openActiveShell = (shell: ShellSessionSummary, options: { markSeen?: boolean } = {}) => {
    const markSeen = options.markSeen !== false;
    const existingTab = ctx.tabs.find((tab) => getSessionIds(tab.paneTree).includes(shell.name));
    if (existingTab) {
      ctx.setActiveTab(existingTab.id);
    } else {
      ctx.addSessionTab(formatShellDisplayName(shell.name), shell.name);
    }
    if (markSeen && shell.latestSeq !== undefined && shell.latestSeq !== null && shell.lastSeenSeq !== shell.latestSeq) {
      void patchShellUiState(shell.name, { lastSeenSeq: shell.latestSeq });
    }
    if (ctx.mobile) {
      ctx.setSidebarOpen(false);
    }
  };

  const moveShellToBackground = (shell: ShellSessionSummary) => {
    void patchShellUiState(shell.name, { placement: "background" });
    ctx.backgroundShellSession(shell.name);
  };

  const makeShellActive = (shell: ShellSessionSummary) => {
    void patchShellUiState(shell.name, {
      placement: "active",
      ...(shell.latestSeq !== undefined && shell.latestSeq !== null ? { lastSeenSeq: shell.latestSeq } : {}),
    }, { rollbackOnFailure: false });
    openActiveShell(shell, { markSeen: false });
  };

  const placementForShell = (shell: ShellSessionSummary): "active" | "background" => (
    shell.placement ?? (openSessionIds.has(shell.name) ? "active" : "background")
  );

  const reorderShells = async (fromName: string, toName: string) => {
    if (fromName === toName) return;
    const fromIndex = shells.findIndex((shell) => shell.name === fromName);
    const toIndex = shells.findIndex((shell) => shell.name === toName);
    if (fromIndex < 0 || toIndex < 0) return;
    const nextShells = [...shells];
    const [moved] = nextShells.splice(fromIndex, 1);
    if (!moved) return;
    nextShells.splice(toIndex, 0, moved);
    reorderSaveCountRef.current += 1;
    setShells(nextShells);
    setShellsError(null);
    const finishReorderSave = () => {
      reorderSaveCountRef.current = Math.max(0, reorderSaveCountRef.current - 1);
    };
    try {
      const res = await fetch(`${getGatewayUrl()}/api/terminal/sessions/order`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: nextShells.map((shell) => shell.name) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setShellsError("Shell order could not be saved");
        await fetchShells({ silent: true });
        finishReorderSave();
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      if (Array.isArray(data.sessions)) {
        commitShellRefreshState(applyShellRefreshSuccess(
          shellRefreshStateRef.current,
          data.sessions,
          true,
        ));
      } else {
        await fetchShells({ silent: true });
      }
      finishReorderSave();
    } catch (err: unknown) {
      console.warn("Failed to save shell order:", err instanceof Error ? err.message : err);
      setShellsError("Shell order could not be saved");
      await fetchShells({ silent: true });
      finishReorderSave();
    }
  };

  const finishShellDrag = () => {
    setDraggingShellName(null);
    setDragOverShellName(null);
    setDraggingShellPlacement(null);
  };

  const beginShellDrag = (shell: ShellSessionSummary) => {
    setDraggingShellName(shell.name);
    setDraggingShellPlacement(placementForShell(shell));
    setDragOverShellName(null);
  };

  const hoverShellDropTarget = (shell: ShellSessionSummary) => {
    if (!draggingShellName || draggingShellName === shell.name) return;
    if (draggingShellPlacement && draggingShellPlacement !== placementForShell(shell)) return;
    setDragOverShellName(shell.name);
  };

  const dropShellOnTarget = (shell: ShellSessionSummary) => {
    if (draggingShellPlacement && draggingShellPlacement !== placementForShell(shell)) {
      finishShellDrag();
      return;
    }
    if (draggingShellName && draggingShellName !== shell.name) {
      void reorderShells(draggingShellName, shell.name);
    }
    finishShellDrag();
  };

  const openNewSessionMenu = (anchor: NewSessionMenuAnchor) => {
    if (creatingShell) return;
    if (newSessionMenuAnchor !== anchor) {
      void fetchAgentStatuses();
    }
    setNewSessionMenuAnchor((current) => current === anchor ? null : anchor);
  };

  const createAgentSession = async (option: TerminalAgentOption, installed: boolean) => {
    if (creatingShellRef.current) return;
    setNewSessionMenuAnchor(null);
    creatingShellRef.current = true;
    setCreatingShell(true);
    setShellsError(null);
    const cwd = ctx.sidebarSelectedPath ?? DEFAULT_CWD;
    try {
      const label = installed ? option.label : `Install ${option.label}`;
      const cmd = installed
        ? option.launchCommand ?? (option.claudeMode ? "claude" : undefined)
        : terminalAgentVisibleInstallCommand(option);
      const name = await ctx.createShellSessionTab(label, cwd, {
        namePrefix: option.id,
        cmd,
      });
      if (name) {
        await fetchShells({ silent: true });
      } else {
        setShellsError("Failed to create agent session");
      }
    } catch (err: unknown) {
      console.warn("Failed to create agent session:", err instanceof Error ? err.message : err);
      setShellsError("Could not create agent session");
    }
    creatingShellRef.current = false;
    setCreatingShell(false);
    if (ctx.mobile) {
      ctx.setSidebarOpen(false);
    }
  };

  const pendingCloseShell = closeConfirmationShell
    ? unfilteredRenderedShells.find((shell) => shell.name === closeConfirmationShell.name) ?? closeConfirmationShell
    : null;
  const closeConfirmationOverlay = pendingCloseShell ? (
    <ShellCloseConfirmation
      shell={pendingCloseShell}
      mobile={ctx.mobile}
      deleting={deletingShellNames.includes(pendingCloseShell.name)}
      onCancel={() => setCloseConfirmationShell(null)}
      onConfirm={() => {
        const shellName = pendingCloseShell.name;
        setCloseConfirmationShell(null);
        void deleteManagedShell(shellName);
      }}
    />
  ) : null;

  if (!ctx.sidebarOpen && !ctx.mobile) {
    return (
      <>
        <div
          data-testid="terminal-sidebar-shell"
          className="shrink-0"
          style={{
            display: "flex",
            minHeight: 0,
            opacity: 1,
            overflow: "visible",
            transform: "translateX(0)",
            transition: TERMINAL_SIDEBAR_TRANSITION,
            width: 76,
          }}
        >
          <CollapsedSessionsRail
            shells={unfilteredRenderedShells}
            selectedShellName={activeShellName}
            terminalDividerColor="var(--terminal-drawer-border)"
            onExpand={() => ctx.setSidebarOpen(true)}
            creatingShell={creatingShell}
            newSessionMenuOpen={newSessionMenuAnchor === "rail"}
            onNew={() => openNewSessionMenu("rail")}
            onNewMenuClose={() => setNewSessionMenuAnchor(null)}
            onCreateShell={() => void createManagedShell()}
            onCreateAgent={createAgentSession}
            agentStatuses={agentStatuses}
            onOpen={makeShellActive}
          />
        </div>
        {closeConfirmationOverlay}
      </>
    );
  }

  if (!ctx.sidebarOpen) {
    return closeConfirmationOverlay;
  }

  return (
    <>
      <div
        data-testid="terminal-sidebar-shell"
        className="shrink-0 overflow-hidden"
        style={{
          background: "var(--terminal-drawer-bg)",
          borderRight: ctx.mobile ? "none" : "1px solid var(--terminal-drawer-border)",
          borderBottom: ctx.mobile ? "1px solid var(--terminal-drawer-border)" : "none",
          color: "var(--terminal-drawer-fg)",
          display: "flex",
          flexDirection: "column",
          maxHeight: ctx.mobile ? "52%" : undefined,
          minHeight: ctx.mobile ? 360 : undefined,
          opacity: 1,
          overflow: "visible",
          position: "relative",
          transform: "translateX(0)",
          transition: ctx.mobile ? undefined : TERMINAL_SIDEBAR_TRANSITION,
          width: drawerWidth,
        }}
      >
      <div
        className="shrink-0"
        style={{
          background: "var(--terminal-drawer-bg)",
          borderBottom: "1px solid var(--terminal-drawer-border)",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          padding: ctx.mobile ? "16px 20px" : "19px 24px 18px",
        }}
      >
        <div className="flex items-center justify-between" style={{ gap: 16 }}>
          <div className="flex min-w-0 items-center" style={{ gap: 12 }}>
            <div
              data-testid="terminal-expanded-brand"
              className="flex shrink-0 items-center justify-center"
              style={{
                alignSelf: "center",
                background: "var(--terminal-drawer-brand-bg)",
                borderRadius: ctx.mobile ? 12 : 10,
                height: ctx.mobile ? 40 : 38,
                width: ctx.mobile ? 40 : 38,
              }}
            >
              <span
                aria-hidden="true"
                data-testid="terminal-expanded-brand-mask"
                style={{
                  background: "var(--terminal-drawer-brand-fg)",
                  WebkitMaskImage: "url('/matrix-logo.svg')",
                  maskImage: "url('/matrix-logo.svg')",
                  WebkitMaskRepeat: "no-repeat",
                  maskRepeat: "no-repeat",
                  WebkitMaskPosition: "center",
                  maskPosition: "center",
                  WebkitMaskSize: "contain",
                  maskSize: "contain",
                  display: "block",
                  height: ctx.mobile ? 22 : 22,
                  width: ctx.mobile ? 22 : 22,
                }}
              />
            </div>
            <div className="min-w-0">
              <div style={{ color: "var(--terminal-drawer-fg)", fontFamily: "var(--font-sans), system-ui, sans-serif", fontSize: 20, fontWeight: 600, letterSpacing: "-0.01em", lineHeight: "24px" }}>
                matrix os
              </div>
              {!ctx.mobile ? (
                <div className="truncate" style={{ color: "var(--terminal-drawer-muted)", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 13, lineHeight: "17px" }}>
                  {ctx.sidebarSelectedPath ? formatCwd(ctx.sidebarSelectedPath) : "~/projects"}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center" style={{ gap: 10 }}>
            {!ctx.mobile ? (
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  aria-label="New session"
                  aria-haspopup="menu"
                  aria-expanded={newSessionMenuAnchor === "drawer"}
                  onClick={() => openNewSessionMenu("drawer")}
                  disabled={creatingShell}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-primary-button-bg)",
                    border: 0,
                    borderRadius: 10,
                    color: "var(--terminal-drawer-primary-button-fg)",
                    cursor: creatingShell ? "not-allowed" : "pointer",
                    fontSize: 25,
                    height: 40,
                    lineHeight: "28px",
                    opacity: creatingShell ? 0.72 : 1,
                    width: 40,
                  }}
                >
                  <PlusIcon aria-hidden="true" size={18} strokeWidth={2.5} />
                </button>
                {newSessionMenuAnchor === "drawer" ? (
                  <NewSessionMenu
                    align="right"
                    onClose={() => setNewSessionMenuAnchor(null)}
                    onCreateShell={() => void createManagedShell()}
                    onCreateAgent={createAgentSession}
                    agentStatuses={agentStatuses}
                  />
                ) : null}
              </div>
            ) : null}
            {!ctx.mobile && (
              <>
                <button
                  type="button"
                  aria-label="Refresh sessions"
                  onClick={() => void fetchShells()}
                  disabled={shellsLoading}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-button-bg)",
                    border: "1px solid var(--terminal-drawer-button-border)",
                    borderRadius: 10,
                    color: "var(--terminal-drawer-button-fg)",
                    cursor: shellsLoading ? "not-allowed" : "pointer",
                    height: 40,
                    opacity: shellsLoading ? 0.72 : 1,
                    width: 40,
                  }}
                >
                  <RefreshCwIcon
                    className={shellsLoading ? "terminal-refresh-icon--loading" : undefined}
                    data-testid="terminal-refresh-icon"
                    size={17}
                    strokeWidth={1.9}
                  />
                </button>
                <button
                  type="button"
                  aria-label="Hide sessions drawer"
                  onClick={() => ctx.setSidebarOpen(false)}
                  className="flex items-center justify-center"
                  style={{
                    background: "var(--terminal-drawer-button-bg)",
                    border: "1px solid var(--terminal-drawer-button-border)",
                    borderRadius: 10,
                    color: "var(--terminal-drawer-button-fg)",
                    cursor: "pointer",
                    height: 40,
                    width: 40,
                  }}
                >
                  <ChevronsLeftIcon data-testid="terminal-drawer-collapse-icon" size={17} strokeWidth={2} />
                </button>
              </>
            )}
          </div>
        </div>
        <div
          className="flex items-center"
          style={{
            background: "var(--terminal-drawer-search-bg)",
            border: "1px solid var(--terminal-drawer-search-border)",
            borderRadius: ctx.mobile ? 14 : 10,
            gap: 10,
            height: ctx.mobile ? 48 : 40,
            padding: "0 14px",
          }}
        >
          <SearchIcon size={18} strokeWidth={1.9} color="var(--terminal-drawer-search-icon)" />
          <input
            aria-label="Search sessions"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a session..."
            style={{
              background: "transparent",
              border: 0,
              color: "var(--terminal-drawer-fg)",
              flex: 1,
              fontSize: ctx.mobile ? 16 : 15,
              minWidth: 0,
            }}
          />
        </div>
      </div>

      <div
        data-testid="terminal-sessions-scroll"
        data-terminal-scrollbar="drawer"
        className="terminal-sessions-scroll min-h-0 flex-1 overflow-y-auto"
        style={{ display: "flex", flexDirection: "column", gap: 18, padding: ctx.mobile ? 20 : 18 }}
      >
        {shellsLoading && (
          <div style={{ color: "var(--terminal-drawer-muted)", fontSize: 12, padding: "24px 0", textAlign: "center" }}>Loading sessions...</div>
        )}
        {!shellsLoading && shellsStale && renderedShells.length > 0 && (
          <div
            data-testid="terminal-sessions-stale-label"
            style={{
              background: "#FFF7DA",
              border: "1px solid #EADFAE",
              borderRadius: 8,
              color: "#7C5A0B",
              fontSize: 12,
              lineHeight: "16px",
              padding: "9px 10px",
              textAlign: "center",
            }}
          >
            Terminal session data is stale. Retry refresh.
          </div>
        )}
        {!shellsLoading && shellsError && (
          <div style={{ color: "#8F6712", fontSize: 12, padding: "24px 0", textAlign: "center" }}>{shellsError}</div>
        )}
        {!shellsLoading && !shellsError && !creatingShell && renderedShells.length === 0 && (
          <div style={{ color: "var(--terminal-drawer-muted)", fontSize: 12, padding: "24px 0", textAlign: "center" }}>
            {filter ? "No sessions match" : "No sessions yet"}
          </div>
        )}
        {!shellsLoading && (activeShells.length > 0 || creatingShell) && (
          <ShellSessionGroup
            label="Active"
            shells={activeShells}
            pending={creatingShell}
            deletingShellNames={deletingShellNames}
            foreground
            selectedShellName={activeShellName}
            onOpen={openActiveShell}
            onToggle={moveShellToBackground}
            onRename={(shell, nextName) => renameManagedShell(shell, nextName)}
            onDelete={(shell) => setCloseConfirmationShell(shell)}
            draggingShellName={draggingShellName}
            dragOverShellName={dragOverShellName}
            onDragStart={beginShellDrag}
            onDragOver={hoverShellDropTarget}
            onDrop={dropShellOnTarget}
            onDragEnd={finishShellDrag}
          />
        )}
        {!shellsLoading && renderedShells.length > 0 && (
          <ShellSessionGroup
            label="Background"
            shells={backgroundShells}
            expanded={backgroundSessionsExpanded}
            onToggleExpanded={() => setBackgroundSessionsExpanded((expanded) => !expanded)}
            deletingShellNames={deletingShellNames}
            foreground={false}
            selectedShellName={activeShellName}
            onOpen={makeShellActive}
            onToggle={makeShellActive}
            onRename={(shell, nextName) => renameManagedShell(shell, nextName)}
            onDelete={(shell) => setCloseConfirmationShell(shell)}
            draggingShellName={draggingShellName}
            dragOverShellName={dragOverShellName}
            onDragStart={beginShellDrag}
            onDragOver={hoverShellDropTarget}
            onDrop={dropShellOnTarget}
            onDragEnd={finishShellDrag}
          />
        )}
      </div>
      <div
        data-testid="terminal-sidebar-footer"
        className="shrink-0"
        style={{
          alignItems: "center",
          background: "var(--terminal-drawer-bg)",
          borderTop: "1px solid var(--terminal-drawer-border)",
          display: "flex",
          justifyContent: "flex-start",
          padding: ctx.mobile ? "13px 20px calc(13px + env(safe-area-inset-bottom))" : "12px 18px",
        }}
      >
        <ThemePickerButton mobile={ctx.mobile} menuPlacement="above-start" />
      </div>
      {!ctx.mobile ? (
        <button
          type="button"
          aria-label="Resize sessions drawer"
          className="terminal-drawer-resize-handle"
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          style={{
            background: "var(--terminal-drawer-resize-handle-bg)",
            border: 0,
            bottom: 0,
            cursor: "col-resize",
            margin: 0,
            outline: "none",
            position: "absolute",
            right: 0,
            top: 0,
            width: 8,
            zIndex: 5,
          }}
        />
      ) : null}
    </div>
      {closeConfirmationOverlay}
    </>
  );
}

function formatCloseConfirmationMeta(shell: ShellSessionSummary): string {
  const placement = shell.placement === "background" ? "background" : "active";
  const unreadCount = typeof shell.latestSeq === "number" && typeof shell.lastSeenSeq === "number"
    ? Math.max(0, shell.latestSeq - shell.lastSeenSeq)
    : shell.unread ? 1 : 0;
  return unreadCount > 0 ? `${placement} · ${unreadCount} unread` : placement;
}

function ShellCloseConfirmation({
  shell,
  mobile,
  deleting,
  onCancel,
  onConfirm,
}: {
  shell: ShellSessionSummary;
  mobile: boolean;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const displayName = formatShellDisplayName(shell.name);
  const titleId = "terminal-close-confirmation-title";
  const bodyCopy = mobile
    ? "Closing permanently deletes this session and its transcript. This can't be undone."
    : "Closing ends the session and permanently deletes it and its transcript. You won't be able to reopen or recover it — this can't be undone.";
  const sessionMeta = formatCloseConfirmationMeta(shell);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
  const sheetStyle: CSSProperties = mobile
    ? {
        background: "#FFFDF7",
        borderTopLeftRadius: 26,
        borderTopRightRadius: 26,
        boxShadow: "0 -18px 50px rgba(0,0,0,0.44)",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        maxWidth: 390,
        padding: "10px 22px 0",
        width: "100%",
      }
    : {
        background: "#FFFDF7",
        border: "1px solid #E4E2D2",
        borderRadius: 12,
        boxShadow: "0 26px 64px rgba(0,0,0,0.34)",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: "calc(100% - 48px)",
        padding: 16,
        width: 340,
      };
  return (
    <dialog
      open
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{
        alignItems: mobile ? "flex-end" : "center",
        background: "rgba(3, 10, 3, 0.74)",
        border: 0,
        bottom: 0,
        display: "flex",
        justifyContent: "center",
        left: 0,
        margin: 0,
        maxHeight: "none",
        maxWidth: "none",
        padding: mobile ? 0 : 24,
        position: "absolute",
        right: 0,
        top: 0,
        width: "auto",
        zIndex: 40,
      }}
    >
      <button
        type="button"
        aria-label="Cancel close session"
        onClick={onCancel}
        style={{
          background: "transparent",
          border: 0,
          bottom: 0,
          cursor: "default",
          left: 0,
          padding: 0,
          position: "absolute",
          right: 0,
          top: 0,
        }}
      />
      <div data-testid="terminal-close-confirmation-sheet" style={{ ...sheetStyle, position: "relative", zIndex: 1 }}>
        {mobile ? (
          <div className="flex items-center justify-center" style={{ paddingBottom: 6 }}>
            <span style={{ background: "#D6D5C4", borderRadius: 999, height: 5, width: 42 }} />
          </div>
        ) : null}
        <div style={{ alignItems: "flex-start", display: "flex", gap: mobile ? 14 : 12 }}>
          <div
            className="flex shrink-0 items-center justify-center"
            style={{
              background: "#F0EFE5",
              border: "1px solid #DCDAC9",
              borderRadius: mobile ? 13 : 10,
              color: "#77786E",
              height: mobile ? 46 : 36,
              width: mobile ? 46 : 36,
            }}
          >
            <Trash2Icon aria-hidden="true" size={mobile ? 21 : 16} strokeWidth={2} />
          </div>
          <div style={{ display: "flex", flex: "1 1 0%", flexDirection: "column", gap: mobile ? 6 : 4, minWidth: 0, paddingTop: mobile ? 2 : 0 }}>
            <div
              id={titleId}
              style={{
                color: "#2A2E22",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: mobile ? 19 : 14,
                fontWeight: 700,
                lineHeight: mobile ? "24px" : "18px",
              }}
            >
              Close this session?
            </div>
            <div
              style={{
                color: "#858578",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: mobile ? 14 : 11,
                lineHeight: mobile ? "20px" : "15px",
              }}
            >
              {bodyCopy}
            </div>
          </div>
        </div>
        <div
          style={{
            alignItems: "center",
            background: "#F4F3E9",
            border: "1px solid #E4E2D2",
            borderRadius: mobile ? 12 : 10,
            display: "flex",
            flexShrink: 0,
            gap: mobile ? 10 : 8,
            height: mobile ? 48 : 30,
            padding: mobile ? "0 14px" : "0 10px",
          }}
        >
          <span
            className={getShellStatusDotClassName(shell)}
            aria-hidden="true"
            style={{
              ...getShellStatusDotStyle(shell),
              borderRadius: 999,
              flexShrink: 0,
              height: mobile ? 8 : 6,
              width: mobile ? 8 : 6,
            }}
          />
          <span
            className="truncate"
            style={{
              color: "#31362D",
              flex: "1 1 0%",
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: mobile ? 15 : 11,
              fontWeight: 700,
              lineHeight: mobile ? "18px" : "14px",
              minWidth: 0,
            }}
          >
            {displayName}
          </span>
          <span
            style={{
              color: "#A09F92",
              flexShrink: 0,
              fontFamily: "Inter, system-ui, sans-serif",
              fontSize: mobile ? 12 : 10,
              fontWeight: 500,
              lineHeight: mobile ? "16px" : "12px",
            }}
          >
            {sessionMeta}
          </span>
        </div>
        {mobile ? (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <button
                type="button"
                aria-label="Delete"
                disabled={deleting}
                onClick={onConfirm}
                className="flex items-center justify-center"
                style={{
                  background: "#2A2E22",
                  border: 0,
                  borderRadius: 14,
                  color: "#F8F7EF",
                  cursor: deleting ? "not-allowed" : "pointer",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  gap: 8,
                  height: 52,
                  opacity: deleting ? 0.68 : 1,
                }}
              >
                <Trash2Icon aria-hidden="true" size={17} strokeWidth={2} />
                Delete
              </button>
              <button
                type="button"
                aria-label="Cancel"
                onClick={onCancel}
                className="flex items-center justify-center"
                style={{
                  background: "#F0EFE5",
                  border: "1px solid #DCDAC9",
                  borderRadius: 14,
                  color: "#3E4339",
                  cursor: "pointer",
                  fontFamily: "Inter, system-ui, sans-serif",
                  fontSize: 16,
                  fontWeight: 600,
                  height: 52,
                }}
              >
                Cancel
              </button>
            </div>
            <div className="flex items-center justify-center" style={{ paddingBottom: 9, paddingTop: 8 }}>
              <span style={{ background: "#1F221B", borderRadius: 999, height: 5, width: 140 }} />
            </div>
          </>
        ) : (
          <div style={{ alignItems: "center", display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button
              type="button"
              aria-label="Cancel"
              onClick={onCancel}
              className="flex items-center justify-center"
              style={{
                background: "#F0EFE5",
                border: "1px solid #DCDAC9",
                borderRadius: 7,
                color: "#3E4339",
                cursor: "pointer",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 600,
                height: 30,
                padding: "0 14px",
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              aria-label="Delete"
              disabled={deleting}
              onClick={onConfirm}
              className="flex items-center justify-center"
              style={{
                background: "#2A2E22",
                border: 0,
                borderRadius: 7,
                color: "#F8F7EF",
                cursor: deleting ? "not-allowed" : "pointer",
                fontFamily: "Inter, system-ui, sans-serif",
                fontSize: 12,
                fontWeight: 600,
                gap: 6,
                height: 30,
                opacity: deleting ? 0.68 : 1,
                padding: "0 14px",
              }}
            >
              <Trash2Icon aria-hidden="true" size={13} strokeWidth={2} />
              Delete
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
