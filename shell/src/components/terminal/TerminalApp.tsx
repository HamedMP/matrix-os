"use client";

import { createContext, use, useEffect, useEffectEvent, useRef, useCallback, useState, type CSSProperties, type KeyboardEvent, type MouseEventHandler, type PointerEventHandler } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ClipboardPasteIcon,
  FilesIcon,
  FolderIcon,
  GripVerticalIcon,
  KeyboardIcon,
  LinkIcon,
  MonitorIcon,
  PanelLeftOpenIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Rows2Icon,
  SearchIcon,
  SquareTerminalIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { type PaneNode, countPanes as countPanesFromStore, getAllPaneIds } from "@/stores/terminal-store";
import { PaneGrid } from "./PaneGrid";
import { saveTheme, useTheme } from "@/hooks/useTheme";
import { getGatewayUrl } from "@/lib/gateway";
import { MATRIX_OS_APP_THEME_OPTIONS, MATRIX_OS_DARK_THEME, MATRIX_OS_LIGHT_THEME } from "@/lib/theme-presets";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { drainTerminalLaunchQueue, TERMINAL_LAUNCH_EVENT } from "@/lib/terminal-launch";
import { useTerminalSettings, type ShellThemeId, type TerminalThemeId } from "@/stores/terminal-settings";
import { getTerminalThemePreset } from "./terminal-themes";
import { TerminalKeyBar } from "./TerminalKeyBar";
import { isCanonicalShellSessionId, isLegacyPtySessionId } from "./terminal-session-id";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";

export { TERMINAL_INPUT_EVENT };
export type { TerminalInputEventDetail };

const TOOLBAR_BTN_BASE_STYLE: CSSProperties = {
  height: 28,
  minWidth: 28,
  fontSize: 12,
  borderRadius: 6,
};

const PAPER_THEME_BUTTON_STYLE: CSSProperties = {
  alignItems: "center",
  background: "#20241C",
  border: "1px solid #2D3127",
  borderRadius: 9,
  color: "#C9C7B7",
  cursor: "pointer",
  display: "flex",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 14,
  fontWeight: 600,
  gap: 8,
  height: 34,
  justifyContent: "center",
  padding: "0 12px",
};

const PAPER_THEME_MENU_STYLE: CSSProperties = {
  background: "#20241C",
  border: "1px solid #2D3127",
  borderRadius: 14,
  boxShadow: "0 18px 44px rgba(0, 0, 0, 0.42)",
  color: "#F0EFE5",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  marginTop: 8,
  padding: 6,
  position: "absolute",
  right: 0,
  top: 34,
  width: 280,
  zIndex: 50,
};

const ACTIVE_SHELL_TOGGLE_STYLE: CSSProperties = {
  alignItems: "center",
  background: "#DDEDD6",
  border: "1px solid #C9E1C2",
  borderRadius: 999,
  color: "#24452A",
  cursor: "pointer",
  display: "flex",
  flexShrink: 0,
  height: 18,
  justifyContent: "flex-start",
  padding: 2,
  pointerEvents: "auto",
  width: 40,
};

const BACKGROUND_SHELL_TOGGLE_STYLE: CSSProperties = {
  alignItems: "center",
  background: "#D8D7C7",
  border: "1px solid #C8C7B7",
  borderRadius: 999,
  color: "#77786E",
  cursor: "pointer",
  display: "flex",
  flexShrink: 0,
  height: 18,
  justifyContent: "flex-end",
  padding: 2,
  pointerEvents: "auto",
  width: 38,
};

const SHELL_THEME_OPTIONS: Array<{
  id: ShellThemeId;
  label: string;
  badge: "RECOMMENDED" | "NOT FULLY TUNED";
  badgeTone: "recommended" | "warning";
  description: string;
  preview: {
    background: string;
    border: string;
    line: string;
    dotA: string;
    dotB: string;
  };
}> = [
  {
    id: "dark",
    label: "Dark",
    badge: "RECOMMENDED",
    badgeTone: "recommended",
    description: "Zellij default · best contrast",
    preview: {
      background: "#0C0C0C",
      border: "#15180F",
      line: "#0AD18B",
      dotA: "#2BD9D9",
      dotB: "#F1FA5C",
    },
  },
  {
    id: "light",
    label: "Light",
    badge: "NOT FULLY TUNED",
    badgeTone: "warning",
    description: "gruvbox-light",
    preview: {
      background: "#FBF1C7",
      border: "#E4D9B0",
      line: "#3C3836",
      dotA: "#79740E",
      dotB: "#CC241D",
    },
  },
  {
    id: "matrix",
    label: "Matrix",
    badge: "NOT FULLY TUNED",
    badgeTone: "warning",
    description: "custom · green on black",
    preview: {
      background: "#020A02",
      border: "#0E5A26",
      line: "#39FF6A",
      dotA: "#5BF08A",
      dotB: "#00CC44",
    },
  },
];

const TAB_ITEM_BASE_STYLE: CSSProperties = {
  borderRadius: 6,
  fontSize: 12,
  height: 34,
};

const TAB_CLOSE_BUTTON_STYLE: CSSProperties = {
  width: 16,
  height: 16,
  flexShrink: 0,
  borderRadius: 3,
  border: "none",
  background: "transparent",
  color: "var(--muted-foreground)",
  opacity: 0.5,
  marginLeft: "auto",
};

const ACTIVE_TAB_PILL_STYLE: CSSProperties = {
  alignItems: "center",
  background: "color-mix(in srgb, var(--primary) 16%, transparent)",
  border: "1px solid color-mix(in srgb, var(--primary) 44%, transparent)",
  borderRadius: 999,
  color: "var(--primary)",
  display: "inline-flex",
  flex: "0 0 auto",
  fontSize: 12,
  fontWeight: 800,
  height: 18,
  lineHeight: "16px",
  padding: "0 6px",
};

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

const SIDEBAR_RAIL_BUTTON_BASE_STYLE: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 700,
};

const SHELLS_REFRESH_INTERVAL_MS = 5_000;
const SHELL_SESSION_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
const TERMINAL_SIDEBAR_TRANSITION = "opacity 140ms ease, transform 180ms ease";
const SESSION_ACTIONS_STYLE: CSSProperties = {
  gap: 6,
  transition: "opacity 120ms ease",
  width: 58,
};
const SESSION_RENAME_BUTTON_STYLE: CSSProperties = {
  background: "#F0EFE5",
  border: "1px solid #E4E2D2",
  borderRadius: 6,
  color: "#8A8B7C",
  flexShrink: 0,
  height: 22,
  pointerEvents: "auto",
  transition: "opacity 120ms ease",
  width: 22,
};
const SESSION_COPY_BUTTON_STYLE: CSSProperties = {
  background: "#F0EFE5",
  border: "1px solid #E4E2D2",
  borderRadius: 6,
  cursor: "pointer",
  flexShrink: 0,
  fontSize: 12,
  fontWeight: 800,
  height: 24,
  overflow: "visible",
  pointerEvents: "auto",
  position: "relative",
  transition: "background-color 120ms ease, border-color 120ms ease, color 120ms ease",
  width: 24,
};
const SESSION_COPY_TOAST_STYLE: CSSProperties = {
  background: "#465243",
  borderRadius: 6,
  color: "#F8F7EF",
  fontFamily: "Inter, system-ui, sans-serif",
  fontSize: 12,
  fontWeight: 800,
  left: -13,
  lineHeight: "18px",
  pointerEvents: "none",
  position: "absolute",
  textAlign: "center",
  top: 28,
  width: 50,
};
const SESSION_CLOSE_BUTTON_STYLE: CSSProperties = {
  background: "#F0EFE5",
  border: "1px solid #E4E2D2",
  borderRadius: 6,
  color: "#77786E",
  fontSize: 15,
  height: 24,
  lineHeight: "20px",
  pointerEvents: "auto",
  width: 24,
};
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

const PROJECT_BRANCH_BADGE_STYLE: CSSProperties = {
  padding: "1px 5px",
  borderRadius: 3,
  background: "var(--background)",
  border: "1px solid var(--border)",
  fontFamily: "var(--font-mono, ui-monospace, monospace)",
  maxWidth: 100,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

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

async function copyTextToClipboard(text: string): Promise<void> {
  let legacyCopyError: unknown = null;
  if (typeof document !== "undefined" && typeof document.execCommand === "function") {
    const previousActiveElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousSelection = document.getSelection()?.rangeCount ? document.getSelection()?.getRangeAt(0).cloneRange() : null;
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    try {
      if (document.execCommand("copy")) {
        return;
      }
      legacyCopyError = new Error("execCommand copy returned false");
    } catch (err: unknown) {
      legacyCopyError = err;
    } finally {
      textarea.remove();
      const selection = document.getSelection();
      if (selection) {
        selection.removeAllRanges();
        if (previousSelection) {
          selection.addRange(previousSelection);
        }
      }
      previousActiveElement?.focus({ preventScroll: true });
    }
  }
  if (typeof navigator !== "undefined" && navigator.clipboard) {
    await navigator.clipboard.writeText(text);
    return;
  }
  throw new Error(legacyCopyError instanceof Error ? legacyCopyError.message : "Clipboard copy unavailable");
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

function renameSessionInTree(node: PaneNode, fromSessionId: string, toSessionId: string): PaneNode {
  if (node.type === "pane") {
    return node.sessionId === fromSessionId ? { ...node, sessionId: toSessionId } : node;
  }
  const left = renameSessionInTree(node.children[0], fromSessionId, toSessionId);
  const right = renameSessionInTree(node.children[1], fromSessionId, toSessionId);
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

function getCanonicalShellSessionIds(layout: TerminalLayout): string[] {
  if (!Array.isArray(layout.tabs)) {
    return [];
  }
  const seen = new Set<string>();
  for (const tab of layout.tabs) {
    for (const sessionId of getSessionIds(tab.paneTree)) {
      if (isCanonicalShellSessionId(sessionId)) {
        seen.add(sessionId);
      }
    }
  }
  return Array.from(seen);
}

function destroyTerminalSessions(sessionIds: string[]) {
  const uniqueIds = Array.from(new Set(sessionIds.filter((sessionId) => sessionId.length > 0)));
  for (const sessionId of uniqueIds) {
    const isCanonical = isCanonicalShellSessionId(sessionId);
    const isLegacyPty = isLegacyPtySessionId(sessionId);
    if (!isCanonical && !isLegacyPty) {
      continue;
    }
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

function getSafePreferencesSessionName(value: string | null): string | null {
  return value && /^[a-z0-9][a-z0-9-]{0,30}$/.test(value) ? value : null;
}

function mapTerminalThemeToShellTheme(themeId: TerminalThemeId | undefined): ShellThemeId {
  if (themeId === "dark" || themeId === "light" || themeId === "matrix") {
    return themeId;
  }
  if (themeId === "one-light" || themeId === "solarized-light" || themeId === "github-light") {
    return "light";
  }
  return "dark";
}

function loadShellThemePreference(sessionName: string | null, setThemeId: (themeId: TerminalThemeId) => void): void {
  if (!sessionName || typeof fetch !== "function") {
    return;
  }
  void fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(sessionName)}/preferences`, {
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

export interface TerminalWindowControls {
  close?: () => void;
  minimize?: () => void;
  toggleFullscreen?: () => void;
  dragHandleProps?: TerminalWindowDragHandleProps;
}

interface TerminalWindowDragHandleProps {
  onPointerDown?: PointerEventHandler<HTMLElement>;
  onPointerMove?: PointerEventHandler<HTMLElement>;
  onPointerUp?: PointerEventHandler<HTMLElement>;
  onPointerCancel?: PointerEventHandler<HTMLElement>;
  onMouseDown?: MouseEventHandler<HTMLElement>;
  onDoubleClick?: MouseEventHandler<HTMLElement>;
}

interface TerminalAppProps {
  initialCommand?: string;
  initialLabel?: string;
  initialClaudeMode?: boolean;
  initialSessionId?: string;
  launchTargetId?: string;
  mobile?: boolean;
  windowControls?: TerminalWindowControls;
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive core terminal shell component; extraction tracked separately. prefer-useReducer: the 6 useState fields are independent, not one related cluster: tabs/activeTabId/focusedPaneId are mutated through many distinct code paths (split, close, rename, reorder, session-attach) using nested functional updaters that read prev and call sibling setters, while sidebarOpen/sidebarSelectedPath are sidebar UI and initialized is a one-time bootstrap gate; a single reducer would not be a mechanical, behavior-identical change.
export function TerminalApp({ initialCommand, initialLabel, initialClaudeMode = false, initialSessionId, launchTargetId, mobile = false, windowControls }: TerminalAppProps = {}) {
  const theme = useTheme();
  const themeId = useTerminalSettings((s) => s.themeId);

  // Match the padding around the xterm to the active terminal theme so the
  // user never sees a colored seam between the OS theme bg and the xterm
  // bg. Falls back to the desktop theme bg when "Match OS" is selected.
  const terminalPreset = themeId === "system" ? null : getTerminalThemePreset(themeId);
  const terminalBackground =
    themeId === "system"
      ? (theme.colors.background || "var(--background)")
      : terminalPreset?.background ?? "var(--background)";
  const terminalForeground =
    themeId === "system"
      ? (theme.colors.foreground || "var(--foreground)")
      : terminalPreset?.foreground ?? "var(--foreground)";
  const terminalAccent =
    themeId === "system"
      ? (theme.colors.primary || "var(--primary)")
      : terminalPreset?.cursor ?? "var(--primary)";

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState("");
  const [focusedPaneId, setFocusedPaneId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarSelectedPath, setSidebarSelectedPath] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

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
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- stable identity for effect dep: `log` is consumed in the dependency array of the tabs-changed useEffect below; removing the memo would re-create it every render and re-run that effect.
  const log = useCallback((event: string, details: Record<string, unknown> = {}) => {
    terminalAppDebug(event, {
      activeTabId: activeTabIdRef.current,
      focusedPaneId,
      tabIds: tabsRef.current.map((tab) => tab.id),
      ...details,
    });
  }, [focusedPaneId]);

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
      },
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    setFocusedPaneId(paneId);
    return id;
  };

  const createShellSessionTab = async (label: string, cwd = DEFAULT_CWD) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = `matrix-${genId()}`;
      try {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential-by-design retry loop: each attempt only runs if the prior one failed with a 409 name collision or abort; parallelizing would create multiple sessions
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
                setTabs(data.tabs);
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

    if (layoutSaveTimerRef.current) {
      clearTimeout(layoutSaveTimerRef.current);
    }

    layoutSaveTimerRef.current = setTimeout(() => {
      layoutSaveTimerRef.current = null;
      flushLayout();
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

      if (layoutSaveTimerRef.current) {
        clearTimeout(layoutSaveTimerRef.current);
        layoutSaveTimerRef.current = null;
      }

      flushLayout();
    };

    window.addEventListener("pagehide", flushOnPageHide);
    return () => {
      window.removeEventListener("pagehide", flushOnPageHide);
    };
  }, [initialized]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      if ((entries[0]?.contentRect.width ?? 0) < 500 && sidebarOpen) setSidebarOpen(false);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [sidebarOpen]);

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!e.ctrlKey || !e.shiftKey) return;
    switch (e.key.toUpperCase()) {
      case "T": e.preventDefault(); void createShellSessionTab("Shell", getCwd()); break;
      case "W": e.preventDefault(); if (focusedPaneId) closePane(focusedPaneId); break;
      case "D": e.preventDefault(); if (focusedPaneId) splitPane(focusedPaneId, "horizontal"); break;
      case "E": e.preventDefault(); if (focusedPaneId) splitPane(focusedPaneId, "vertical"); break;
      case "B": e.preventDefault(); setSidebarOpen(o => !o); break;
      case "C": e.preventDefault(); addTab(getCwd(), "Claude Code", true); break;
      case "Z": e.preventDefault(); void createShellSessionTab("Shell", getCwd()); break;
    }
  };

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Construct store-compatible interface for child components
  const storeApi = {
    tabs, activeTabId, sidebarOpen, sidebarSelectedPath, focusedPaneId, mobile, themeName: theme.name, windowControls,
    addTab, addSessionTab, createShellSessionTab, backgroundShellSession, closeTab, setActiveTab: setActiveTabId, renameTab, renameShellSession, reorderTabs,
    splitPane, closePane, setFocusedPane: setFocusedPaneId,
    setSidebarOpen, setSidebarSelectedPath,
  };

  return (
    <div
      ref={containerRef}
      className="flex flex-col h-full w-full"
      style={{ background: "var(--background)" }}
      role="application"
      aria-label="Terminal"
      onKeyDown={handleKeyDown}
    >
      <style>{SHELL_STATUS_DOT_CSS}</style>
      <TerminalAppContext.Provider value={storeApi}>
        <TerminalWorkspaceChrome />
        <div className={mobile ? "relative flex flex-1 min-h-0 flex-col" : "relative flex flex-1 min-h-0"}>
          <LocalTerminalSidebar />
          {activeTab ? (
            <div
              className="flex-1 min-w-0 min-h-0 flex"
              style={{
                padding: mobile ? "0" : "20px",
                background: "#1C2019",
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
                />
                {mobile && (
                  <>
                    <MobileTerminalActions
                      defaultCwd={DEFAULT_CWD}
                      background={terminalBackground}
                      foreground={terminalForeground}
                      accent={terminalAccent}
                    />
                    <MobileCommandComposer
                      onSend={(data) => dispatchPaneInput(focusedPaneId, data)}
                      background={terminalBackground}
                      foreground={terminalForeground}
                      accent={terminalAccent}
                    />
                    <TerminalKeyBar
                      onSend={(data) => dispatchPaneInput(focusedPaneId, data)}
                      background={terminalBackground}
                      foreground={terminalForeground}
                      accent={terminalAccent}
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

// ---- Context for local state ----

interface TerminalAppContextType {
  tabs: Tab[];
  activeTabId: string;
  sidebarOpen: boolean;
  sidebarSelectedPath: string | null;
  focusedPaneId: string | null;
  mobile: boolean;
  themeName: string;
  windowControls?: TerminalWindowControls;
  addTab: (cwd: string, label?: string, claude?: boolean, startupCommand?: string) => string;
  addSessionTab: (label: string, sessionId: string, cwd?: string) => string;
  createShellSessionTab: (label: string, cwd?: string) => Promise<string | null>;
  backgroundShellSession: (sessionId: string) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  renameTab: (tabId: string, label: string) => void;
  renameShellSession: (fromSessionId: string, toSessionId: string) => void;
  reorderTabs: (from: number, to: number) => void;
  splitPane: (paneId: string, dir: "horizontal" | "vertical") => void;
  closePane: (paneId: string) => void;
  setFocusedPane: (paneId: string) => void;
  setSidebarOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setSidebarSelectedPath: (path: string | null) => void;
}

const TerminalAppContext = createContext<TerminalAppContextType | null>(null);

function useTerminalAppContext() {
  const ctx = use(TerminalAppContext);
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
interface ToolbarBtnProps {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
  variant?: "default" | "primary" | "success";
  ariaLabel?: string;
}
function ToolbarBtn({ onClick, title, children, variant = "default", ariaLabel }: ToolbarBtnProps) {
  const colors =
    variant === "success"
      ? { bg: "var(--success)", color: "white", border: "transparent" }
      : variant === "primary"
        ? { bg: "var(--primary)", color: "white", border: "transparent" }
        : { bg: "transparent", color: "var(--muted-foreground)", border: "transparent" };
  return (
    <button
      type="button"
      className="cursor-pointer transition-colors flex items-center justify-center gap-1.5"
      style={{
        ...TOOLBAR_BTN_BASE_STYLE,
        padding: variant === "default" ? "0 6px" : "0 10px",
        fontWeight: variant === "default" ? 400 : 500,
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
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </button>
  );
}

function ThemePickerButton() {
  const ctx = useTerminalAppContext();
  const [open, setOpen] = useState(false);
  const [shellThemeOpen, setShellThemeOpen] = useState(false);
  const [selectedAppThemeOverride, setSelectedAppThemeOverride] = useState<string | null>(null);
  const [matchSystem, setMatchSystem] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const setTerminalThemeId = useTerminalSettings((s) => s.setThemeId);
  const selectedAppThemeName = selectedAppThemeOverride ?? ctx.themeName;
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
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const persistTheme = (theme: (typeof MATRIX_OS_APP_THEME_OPTIONS)[number]["theme"], nextMatchSystem = false) => {
    setSelectedAppThemeOverride(theme.name);
    setMatchSystem(nextMatchSystem);
    void saveTheme(theme).catch((err: unknown) => {
      console.warn("Failed to save terminal app theme:", err instanceof Error ? err.message : err);
    });
  };

  const applySystemTheme = () => {
    const prefersDark = typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    persistTheme(prefersDark ? MATRIX_OS_DARK_THEME : MATRIX_OS_LIGHT_THEME, true);
  };

  const panel = (
    <ThemePickerPanel
      matchSystem={matchSystem}
      mobile={ctx.mobile}
      selectedAppThemeName={selectedAppThemeName}
      onSelectTheme={(theme) => persistTheme(theme, false)}
      onShellThemeOpen={() => {
        loadShellThemePreference(sessionName, setTerminalThemeId);
        setOpen(false);
        setShellThemeOpen(true);
      }}
      onSystemTheme={applySystemTheme}
    />
  );

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative" }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Theme"
        title="Theme"
        style={PAPER_THEME_BUTTON_STYLE}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ color: "#CF7835", fontSize: 17, fontWeight: 600, lineHeight: "22px" }}>☼</span>
        <span>Theme</span>
      </button>
      {shellThemeOpen ? (
        <ShellThemeChooser
          mobile={ctx.mobile}
          sessionName={sessionName}
          onClose={() => setShellThemeOpen(false)}
        />
      ) : null}
      {open && (ctx.mobile ? (
        <div
          aria-label="Theme picker overlay"
          role="presentation"
          style={{
            alignItems: "flex-end",
            background: "rgba(2, 5, 2, 0.58)",
            display: "flex",
            inset: 0,
            justifyContent: "center",
            paddingTop: 64,
            position: "fixed",
            zIndex: 80,
          }}
        >
          {panel}
        </div>
      ) : (
        panel
      ))}
    </div>
  );
}

function ThemePickerPanel({
  matchSystem,
  mobile,
  selectedAppThemeName,
  onSelectTheme,
  onShellThemeOpen,
  onSystemTheme,
}: {
  matchSystem: boolean;
  mobile: boolean;
  selectedAppThemeName: string;
  onSelectTheme: (theme: (typeof MATRIX_OS_APP_THEME_OPTIONS)[number]["theme"]) => void;
  onShellThemeOpen: () => void;
  onSystemTheme: () => void;
}) {
  const panelStyle: CSSProperties = mobile
    ? {
        background: "#FBFAF2",
        borderRadius: "24px 24px 0 0",
        boxShadow: "0 -18px 44px rgba(0, 0, 0, 0.28)",
        color: "#2F332C",
        display: "flex",
        flexDirection: "column",
        gap: 14,
        maxWidth: 390,
        padding: "10px 20px 14px",
        width: "100%",
      }
    : PAPER_THEME_MENU_STYLE;
  const rowHeight = mobile ? 64 : 51;
  const previewSize = mobile ? { width: 48, height: 38 } : { width: 40, height: 32 };

  return (
    <div
      role={mobile ? "dialog" : "menu"}
      aria-label="Theme"
      style={panelStyle}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {mobile ? (
        <>
          <div style={{ alignSelf: "center", background: "#D4D4C4", borderRadius: 999, height: 5, width: 42 }} />
          <div style={{ color: "#20241C", fontSize: 20, fontWeight: 750, lineHeight: "24px" }}>Theme</div>
        </>
      ) : (
        <div style={{ padding: "8px 10px 4px" }}>
          <div style={{ color: "#6F7167", fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", lineHeight: "14px", textTransform: "uppercase" }}>
            Theme
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: mobile ? 0 : 2 }}>
        {MATRIX_OS_APP_THEME_OPTIONS.map((option) => {
          const selected = selectedAppThemeName === option.theme.name;
          return (
            <button
              key={option.id}
              type="button"
              role="menuitemradio"
              aria-checked={selected}
              aria-label={`${option.label} ${option.description}`}
              onClick={() => onSelectTheme(option.theme)}
              style={{
                alignItems: "center",
                background: selected ? (mobile ? "#F2F1E6" : "#2A2E22") : "transparent",
                border: mobile ? "1px solid transparent" : 0,
                borderColor: selected && mobile ? "#DEDCCF" : "transparent",
                borderRadius: mobile ? 10 : 10,
                color: mobile ? "#2F332C" : "#F0EFE5",
                cursor: "pointer",
                display: "flex",
                gap: mobile ? 14 : 12,
                minHeight: rowHeight,
                padding: mobile ? "12px 14px" : "8px 10px",
                textAlign: "left",
                width: "100%",
              }}
            >
              <ThemePreviewSwatch colors={option.preview} height={previewSize.height} width={previewSize.width} />
              <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 1, minWidth: 0 }}>
                <span style={{ color: mobile ? "#20241C" : "#F0EFE5", fontSize: mobile ? 16 : 14, fontWeight: 650, lineHeight: mobile ? "20px" : "18px" }}>
                  {option.label}
                </span>
                <span style={{ color: mobile ? "#77786C" : "#858578", fontSize: mobile ? 13 : 12, lineHeight: mobile ? "16px" : "16px" }}>
                  {option.description}
                </span>
              </span>
              {selected ? <CheckIcon size={mobile ? 20 : 18} strokeWidth={2.4} style={{ color: mobile ? "#4F8A55" : "#9CB77A", flexShrink: 0 }} /> : null}
            </button>
          );
        })}
      </div>

      <ThemeDivider mobile={mobile} />
      <button
        type="button"
        aria-label="Match system"
        onClick={onSystemTheme}
        style={{
          alignItems: "center",
          background: "transparent",
          border: 0,
          borderRadius: 10,
          color: mobile ? "#2F332C" : "#C9C7B7",
          cursor: "pointer",
          display: "flex",
          gap: 12,
          minHeight: mobile ? 32 : 48,
          padding: mobile ? "2px 12px" : "8px 10px",
          textAlign: "left",
          width: "100%",
        }}
      >
        <span style={themeUtilityIconStyle(mobile)}>
          <MonitorIcon size={mobile ? 20 : 17} strokeWidth={2} />
        </span>
        <span style={{ flex: 1, fontSize: mobile ? 16 : 14, fontWeight: 650, lineHeight: mobile ? "20px" : "18px" }}>
          Match system
        </span>
        <ThemeSwitch checked={matchSystem} mobile={mobile} />
      </button>

      <ThemeDivider mobile={mobile} />
      <button
        type="button"
        aria-label="Change shell theme Advanced terminal colors"
        onClick={onShellThemeOpen}
        style={{
          alignItems: "center",
          background: mobile ? "#F2F1E6" : "#1E241B",
          border: `1px solid ${mobile ? "#DEDCCF" : "#303729"}`,
          borderRadius: 10,
          color: mobile ? "#2F332C" : "#EDEBDD",
          cursor: "pointer",
          display: "flex",
          gap: 12,
          minHeight: mobile ? 64 : 48,
          padding: mobile ? "12px 14px" : "8px 10px",
          textAlign: "left",
          width: "100%",
        }}
      >
        <span
          style={{
            ...themeUtilityIconStyle(mobile),
            background: mobile ? "#FFFFFF" : "#12170F",
            borderColor: mobile ? "#DEDDD1" : "#3A4233",
            color: mobile ? "#77786C" : "#D7D4C2",
          }}
        >
          <SquareTerminalIcon size={mobile ? 18 : 16} strokeWidth={2.1} />
        </span>
        <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 1, minWidth: 0 }}>
          <span style={{ color: mobile ? "#2F332C" : "#EDEBDD", fontSize: mobile ? 14 : 13, fontWeight: 700, lineHeight: mobile ? "18px" : "16px" }}>
            Change shell theme
          </span>
          <span style={{ color: mobile ? "#77786C" : "#AFAE9F", fontSize: mobile ? 12 : 11, lineHeight: mobile ? "16px" : "14px" }}>
            Advanced · terminal colors
          </span>
        </span>
        <ChevronRightIcon
          size={mobile ? 18 : 16}
          strokeWidth={2}
          style={{
            color: mobile ? "#77786C" : "#C9C7B7",
            flexShrink: 0,
          }}
        />
      </button>

      {mobile ? (
        <div style={{ alignItems: "center", display: "flex", height: 22, justifyContent: "center" }}>
          <div style={{ background: "#000000", borderRadius: 999, height: 5, width: 140 }} />
        </div>
      ) : null}
    </div>
  );
}

function ShellThemeChooser({
  mobile,
  sessionName,
  onClose,
}: {
  mobile: boolean;
  sessionName: string | null;
  onClose: () => void;
}) {
  const themeId = useTerminalSettings((s) => s.themeId);
  const setThemeId = useTerminalSettings((s) => s.setThemeId);
  const selectedShellThemeId = mapTerminalThemeToShellTheme(themeId);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const dialogNeedsOpenAttribute =
    typeof globalThis.HTMLDialogElement === "undefined" ||
    typeof globalThis.HTMLDialogElement.prototype.showModal !== "function";

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || dialogNeedsOpenAttribute || typeof dialog.showModal !== "function") {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [dialogNeedsOpenAttribute]);

  const persistShellTheme = (next: ShellThemeId) => {
    setThemeId(next);
    if (!sessionName || typeof fetch !== "function") {
      return;
    }
    const state = useTerminalSettings.getState();
    void fetch(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(sessionName)}/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shellThemeId: next,
        fontFamily: state.fontFamily,
        ligatures: state.ligatures,
        cursorStyle: state.cursorStyle,
        smoothScroll: state.smoothScroll,
      }),
      signal: AbortSignal.timeout(10_000),
    }).catch((err: unknown) => {
      console.warn("Failed to save shell theme preferences:", err instanceof Error ? err.message : err);
    });
  };

  const cardStyle: CSSProperties = mobile
    ? {
        background: "#FFFDF7",
        border: "1px solid #E4E2D2",
        borderBottom: 0,
        borderRadius: "26px 26px 0 0",
        boxShadow: "0 -18px 50px rgba(0, 0, 0, 0.44)",
        color: "#2F332C",
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "10px 20px 16px",
        width: "min(390px, 100%)",
      }
    : {
        background: "#FFFDF7",
        border: "1px solid #E4E2D2",
        borderRadius: 18,
        boxShadow: "0 30px 70px rgba(0, 0, 0, 0.37)",
        color: "#2F332C",
        display: "flex",
        flexDirection: "column",
        gap: 18,
        padding: 26,
        width: 460,
      };

  return (
    <dialog
      ref={dialogRef}
      aria-label="Shell theme"
      aria-modal="true"
      open={dialogNeedsOpenAttribute ? true : undefined}
      style={{
        alignItems: mobile ? "flex-end" : "center",
        background: "rgba(2, 5, 2, 0.58)",
        border: 0,
        display: "flex",
        height: "100dvh",
        inset: 0,
        justifyContent: "center",
        margin: 0,
        maxHeight: "none",
        maxWidth: "none",
        overflow: "hidden",
        padding: mobile ? 0 : 24,
        position: "fixed",
        width: "100vw",
        zIndex: 95,
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <button
        type="button"
        aria-label="Dismiss shell theme chooser"
        tabIndex={-1}
        onClick={onClose}
        style={{
          background: "transparent",
          border: 0,
          cursor: "default",
          inset: 0,
          padding: 0,
          position: "absolute",
        }}
      />
      <div
        style={{ ...cardStyle, position: "relative", zIndex: 1 }}
      >
        {mobile ? (
          <div style={{ alignSelf: "center", background: "#D4D4C4", borderRadius: 999, height: 5, width: 42 }} />
        ) : null}
        <div style={{ alignItems: "center", display: "flex", gap: 14 }}>
          <span
            aria-hidden="true"
            style={{
              alignItems: "center",
              background: "#15180F",
              borderRadius: 8,
              color: "#9CB77A",
              display: "flex",
              flexShrink: 0,
              height: mobile ? 42 : 38,
              justifyContent: "center",
              width: mobile ? 42 : 38,
            }}
          >
            <SquareTerminalIcon size={mobile ? 20 : 18} strokeWidth={2} />
          </span>
          <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
            <span style={{ color: "#20241C", fontSize: mobile ? 17 : 15, fontWeight: 800, lineHeight: mobile ? "22px" : "19px" }}>
              Shell theme
            </span>
            <span style={{ color: "#77786C", fontSize: mobile ? 12 : 11, lineHeight: mobile ? "16px" : "15px" }}>
              {mobile
                ? "Terminal colors. We recommend Dark."
                : "Colors for the terminal itself. We recommend Dark — agent output, diffs and status read best."}
            </span>
          </span>
        </div>

        <div role="radiogroup" aria-label="Shell theme options" style={{ display: "flex", flexDirection: "column", gap: mobile ? 9 : 8 }}>
          {SHELL_THEME_OPTIONS.map((option) => {
            const selected = option.id === selectedShellThemeId;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                aria-label={`${option.label} ${option.description}`}
                onClick={() => persistShellTheme(option.id)}
                style={{
                  alignItems: "center",
                  background: selected ? "#F4F3E9" : "#FFFDF7",
                  border: `1px solid ${selected ? "#D6D5C4" : "#E9E6D8"}`,
                  borderRadius: mobile ? 14 : 13,
                  color: "#2F332C",
                  cursor: "pointer",
                  display: "flex",
                  gap: mobile ? 13 : 12,
                  minHeight: mobile ? 58 : 56,
                  padding: mobile ? "10px 12px" : "10px 13px",
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <ShellThemePreviewIcon option={option} mobile={mobile} />
                <span style={{ display: "flex", flex: 1, flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ alignItems: "center", display: "flex", gap: 8, minWidth: 0 }}>
                    <span style={{ color: "#20241C", fontSize: mobile ? 14 : 13, fontWeight: 800, lineHeight: "18px" }}>
                      {option.label}
                    </span>
                    <span
                      style={{
                        background: option.badgeTone === "recommended" ? "#DDEBCE" : "#F4E4A8",
                        borderRadius: 4,
                        color: option.badgeTone === "recommended" ? "#4F8A55" : "#A06F1D",
                        fontSize: mobile ? 7 : 6,
                        fontWeight: 800,
                        letterSpacing: "0.02em",
                        lineHeight: "10px",
                        padding: "1px 4px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {option.badge}
                    </span>
                  </span>
                  <span style={{ color: "#77786C", fontSize: mobile ? 11 : 10, lineHeight: mobile ? "15px" : "13px" }}>
                    {option.description}
                  </span>
                </span>
                {selected ? (
                  <CheckIcon
                    size={mobile ? 17 : 15}
                    strokeWidth={2.4}
                    style={{ color: "#4F8A55", flexShrink: 0 }}
                  />
                ) : null}
              </button>
            );
          })}
        </div>

        <div
          style={{
            background: "#F7F1E2",
            border: "1px solid #ECE2C6",
            borderRadius: 9,
            color: "#8A7B52",
            display: "flex",
            fontSize: mobile ? 10 : 11,
            gap: 10,
            lineHeight: mobile ? "14px" : "16px",
            padding: mobile ? "10px 12px" : "12px 14px",
          }}
        >
          <span aria-hidden="true" style={{ background: "#D2B35F", borderRadius: 999, flexShrink: 0, width: 3 }} />
          <span>
            {mobile
              ? "Light & Matrix aren't fully tuned — some colors lose contrast. Switch back to Dark if output looks off."
              : "Light and Matrix aren't fully tuned — some terminal colors lose contrast. Switch back to Dark if output looks off."}
          </span>
        </div>

        {mobile ? (
          <div style={{ alignItems: "center", display: "flex", height: 18, justifyContent: "center" }}>
            <div style={{ background: "#000000", borderRadius: 999, height: 5, width: 140 }} />
          </div>
        ) : null}
      </div>
    </dialog>
  );
}

function ShellThemePreviewIcon({
  option,
  mobile,
}: {
  option: (typeof SHELL_THEME_OPTIONS)[number];
  mobile: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: option.preview.background,
        border: `1px solid ${option.preview.border}`,
        borderRadius: 6,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: mobile ? 5 : 4,
        height: mobile ? 32 : 28,
        justifyContent: "center",
        width: mobile ? 36 : 34,
      }}
    >
      <span style={{ background: option.preview.line, borderRadius: 2, display: "block", height: 3, width: mobile ? 16 : 15 }} />
      <span style={{ display: "flex", gap: 3 }}>
        <span style={{ background: option.preview.dotA, borderRadius: 999, display: "block", height: 5, width: 5 }} />
        <span style={{ background: option.preview.dotB, borderRadius: 999, display: "block", height: 5, width: 5 }} />
      </span>
    </span>
  );
}

function ThemePreviewSwatch({
  colors,
  height,
  width,
}: {
  colors: (typeof MATRIX_OS_APP_THEME_OPTIONS)[number]["preview"];
  height: number;
  width: number;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        background: colors.background,
        border: `1px solid ${colors.border}`,
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        gap: 4,
        height,
        justifyContent: "center",
        padding: 7,
        width,
      }}
    >
      <span style={{ background: colors.stripe, borderRadius: 2, display: "block", height: 3, width: Math.max(18, width - 22) }} />
      <span style={{ display: "flex", gap: 3 }}>
        <span style={{ background: colors.dotA, borderRadius: 999, display: "block", height: width > 40 ? 7 : 6, width: width > 40 ? 7 : 6 }} />
        <span style={{ background: colors.dotB, borderRadius: 999, display: "block", height: width > 40 ? 7 : 6, width: width > 40 ? 7 : 6 }} />
      </span>
    </span>
  );
}

function ThemeDivider({ mobile }: { mobile: boolean }) {
  return (
    <div
      aria-hidden="true"
      style={{
        background: mobile ? "#DEDDD1" : "#2A2E22",
        height: 1,
        margin: mobile ? "6px 0" : "4px 8px",
      }}
    />
  );
}

function ThemeSwitch({ checked, mobile }: { checked: boolean; mobile: boolean }) {
  return (
    <span
      aria-hidden="true"
      style={{
        alignItems: "center",
        background: checked ? "#CFE0B6" : mobile ? "#E2E1D4" : "#2A2E22",
        border: `1px solid ${checked ? "#A8C77F" : mobile ? "#D4D3C7" : "#3A3E30"}`,
        borderRadius: 999,
        display: "flex",
        flexShrink: 0,
        height: mobile ? 28 : 23,
        justifyContent: checked ? "flex-end" : "flex-start",
        padding: 3,
        width: mobile ? 46 : 40,
      }}
    >
      <span
        style={{
          background: checked ? "#4F8A55" : mobile ? "#FBFAF2" : "#5A5D50",
          borderRadius: 999,
          display: "block",
          height: mobile ? 22 : 17,
          width: mobile ? 22 : 17,
        }}
      />
    </span>
  );
}

function themeUtilityIconStyle(mobile: boolean): CSSProperties {
  return {
    alignItems: "center",
    background: mobile ? "#FFFFFF" : "#171A13",
    border: `1px solid ${mobile ? "#DEDDD1" : "#2D3127"}`,
    borderRadius: 8,
    color: mobile ? "#77786C" : "#858578",
    display: "flex",
    flexShrink: 0,
    height: mobile ? 38 : 32,
    justifyContent: "center",
    width: mobile ? 38 : 40,
  };
}

function isTerminalChromeControl(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("button,input,textarea,select,a,[role='button']"));
}

function TerminalWorkspaceChrome() {
  const ctx = useTerminalAppContext();
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeTabId);
  const activeName = activeTab?.label === DEFAULT_SHELL_SESSION_NAME ? "matrix-main" : activeTab?.label ?? "Terminal";
  const dragHandleProps = ctx.windowControls?.dragHandleProps;
  const handleDragPointerDownCapture: PointerEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onPointerDown?.(event);
  };
  const handleDragMouseDownCapture: MouseEventHandler<HTMLElement> = (event) => {
    if (ctx.mobile || isTerminalChromeControl(event.target)) return;
    dragHandleProps?.onMouseDown?.(event);
  };

  return (
    <div
      className="shrink-0 select-none"
      onPointerDownCapture={handleDragPointerDownCapture}
      onPointerMove={dragHandleProps?.onPointerMove}
      onPointerUp={dragHandleProps?.onPointerUp}
      onPointerCancel={dragHandleProps?.onPointerCancel}
      onMouseDownCapture={handleDragMouseDownCapture}
      onDoubleClick={dragHandleProps?.onDoubleClick}
      style={{
        alignItems: "center",
        background: "#15180F",
        borderBottom: "1px solid #24271F",
        color: "#C9C7B7",
        display: "flex",
        height: ctx.mobile ? 52 : 54,
        justifyContent: "space-between",
        padding: ctx.mobile ? "0 12px" : "0 20px",
        minWidth: 0,
        cursor: dragHandleProps && !ctx.mobile ? "grab" : undefined,
        touchAction: dragHandleProps && !ctx.mobile ? "none" : undefined,
      }}
    >
      <div className="flex min-w-0 items-center" style={{ gap: ctx.mobile ? 10 : 16 }}>
        {!ctx.mobile && (
          <>
            <div className="flex shrink-0 items-center" style={{ gap: 9 }}>
              <TerminalTrafficButton
                label="Close Terminal window"
                color="#E8796B"
                onClick={ctx.windowControls?.close}
              />
              <TerminalTrafficButton
                label="Minimize Terminal window"
                color="#E5BE5F"
                onClick={ctx.windowControls?.minimize}
              />
              <TerminalTrafficButton
                label="Toggle Terminal fullscreen"
                color="#77B861"
                onClick={ctx.windowControls?.toggleFullscreen}
              />
            </div>
            <span style={{ background: "#2D3127", height: 22, width: 1 }} />
          </>
        )}
        {ctx.mobile ? (
          <button
            type="button"
            aria-label={ctx.sidebarOpen ? "Hide sessions" : "Back to sessions"}
            onClick={() => ctx.setSidebarOpen((open) => !open)}
            style={{
              alignItems: "center",
              background: "transparent",
              border: 0,
              color: "#C9C7B7",
              cursor: "pointer",
              display: "flex",
              height: 40,
              justifyContent: "center",
              width: 40,
            }}
          >
            <PanelLeftOpenIcon size={18} strokeWidth={1.9} />
          </button>
        ) : null}
        <div className="flex min-w-0 items-center" style={{ gap: 10, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          <span style={{ color: "#858578", fontSize: 15, lineHeight: "20px" }}>matrix-os</span>
          {!ctx.mobile && <span style={{ color: "#5F6258", fontSize: 15 }}>/</span>}
          <span className="truncate" style={{ color: "#F0EFE5", fontSize: 15, fontWeight: 700, lineHeight: "20px" }}>
            {activeName}
          </span>
          {!ctx.mobile && (
            <span
              className="inline-flex shrink-0 items-center"
              style={{
                background: "#20241C",
                border: "1px solid #24271F",
                borderRadius: 8,
                color: "#858578",
                fontSize: 12,
                gap: 5,
                height: 26,
                padding: "0 9px",
              }}
            >
              main
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center" style={{ gap: 8 }}>
        {!ctx.mobile && (
          <>
            <ChromeIconButton
              label="Split right"
              onClick={() => { if (ctx.focusedPaneId) ctx.splitPane(ctx.focusedPaneId, "horizontal"); }}
            >
              <IconSplitH />
            </ChromeIconButton>
            <ChromeIconButton
              label="Split down"
              onClick={() => { if (ctx.focusedPaneId) ctx.splitPane(ctx.focusedPaneId, "vertical"); }}
            >
              <IconSplitV />
            </ChromeIconButton>
            <span style={{ background: "#2D3127", height: 22, margin: "0 4px", width: 1 }} />
          </>
        )}
        <ThemePickerButton />
      </div>
    </div>
  );
}

function TerminalTrafficButton({
  label,
  color,
  onClick,
}: {
  label: string;
  color: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        background: color,
        border: 0,
        borderRadius: 999,
        cursor: "pointer",
        height: 13,
        padding: 0,
        width: 13,
      }}
    />
  );
}

function ChromeIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className="flex items-center justify-center"
      style={{
        background: "#20241C",
        border: "1px solid #2D3127",
        borderRadius: 9,
        color: "#C9C7B7",
        cursor: "pointer",
        height: 32,
        width: 32,
      }}
    >
      {children}
    </button>
  );
}

function LocalTerminalTabBar({ defaultCwd }: { defaultCwd: string }) {
  const ctx = useTerminalAppContext();
  const dragIndexRef = useRef<number | null>(null);

  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const newTabButton = (
    <ToolbarBtn
      onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
      title="New tab (Ctrl+Shift+T)"
      ariaLabel="New tab"
    >
      <IconPlus />
    </ToolbarBtn>
  );

  return (
    <div
      className="grid items-stretch border-b shrink-0 select-none"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
        height: ctx.mobile ? 50 : 44,
        padding: "4px 6px",
        gap: 4,
        gridTemplateColumns: ctx.mobile ? "1fr" : "minmax(0, 1fr) auto",
        minWidth: 0,
      }}
    >
      <div
        className="flex items-stretch overflow-x-auto min-w-0"
        role="tablist"
        aria-label="Terminal tabs"
        style={{
          gap: 3,
          scrollbarWidth: "thin",
          overscrollBehaviorX: "contain",
        }}
      >
        {ctx.tabs.map((tab, i) => {
          const active = tab.id === ctx.activeTabId;
          const handleTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.target !== e.currentTarget) return;

            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              ctx.setActiveTab(tab.id);
              return;
            }

            const keyToIndex: Record<string, number> = {
              ArrowLeft: i === 0 ? ctx.tabs.length - 1 : i - 1,
              ArrowRight: i === ctx.tabs.length - 1 ? 0 : i + 1,
              Home: 0,
              End: ctx.tabs.length - 1,
            };
            const nextIndex = keyToIndex[e.key];
            const nextTab = ctx.tabs[nextIndex];
            if (!nextTab) return;

            e.preventDefault();
            ctx.setActiveTab(nextTab.id);
            const tabs = Array.from(
              e.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [],
            );
            tabs[nextIndex]?.focus();
          };
          const tabNode = (
            <div
              key={tab.id}
              role="tab"
              tabIndex={active ? 0 : -1}
              aria-selected={active}
              className="flex items-center gap-1.5 cursor-pointer whitespace-nowrap transition-colors"
              style={{
                ...TAB_ITEM_BASE_STYLE,
                background: active ? "var(--background)" : "color-mix(in srgb, var(--background) 42%, transparent)",
                color: active ? "var(--foreground)" : "var(--muted-foreground)",
                border: `1px solid ${active ? "var(--primary)" : "color-mix(in srgb, var(--border) 55%, transparent)"}`,
                padding: ctx.mobile ? "0 7px" : "0 8px",
                fontWeight: active ? 750 : 450,
                flex: ctx.mobile ? "0 1 148px" : "0 1 168px",
                minWidth: ctx.mobile ? 96 : 108,
                maxWidth: ctx.mobile ? 160 : 190,
                boxShadow: active ? "inset 0 -3px 0 var(--primary), 0 0 0 1px color-mix(in srgb, var(--primary) 28%, transparent)" : "none",
              }}
              draggable
              onClick={() => ctx.setActiveTab(tab.id)}
              onKeyDown={handleTabKeyDown}
              onDragStart={() => { dragIndexRef.current = i; }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); if (dragIndexRef.current !== null && dragIndexRef.current !== i) ctx.reorderTabs(dragIndexRef.current, i); dragIndexRef.current = null; }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  flexShrink: 0,
                  borderRadius: "50%",
                  background: active ? "var(--success)" : "var(--muted-foreground)",
                  opacity: active ? 1 : 0.5,
                }}
              />
              <span
                className="min-w-0 truncate"
                style={{ flex: "1 1 auto", overflow: "hidden" }}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{tab.label}</span>
              </span>
              {active && (
                <span
                  aria-hidden="true"
                  style={ACTIVE_TAB_PILL_STYLE}
                >
                  Active
                </span>
              )}
              <button
                type="button"
                className="cursor-pointer flex items-center justify-center transition-colors"
                onClick={(e) => { e.stopPropagation(); ctx.closeTab(tab.id); }}
                style={TAB_CLOSE_BUTTON_STYLE}
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
          return tabNode;
        })}
        {newTabButton}
      </div>
      {!ctx.mobile && (
      <div
        className="flex items-center shrink-0"
        style={{
          gap: 4,
          paddingLeft: 8,
          borderLeft: "1px solid var(--border)",
          minWidth: 0,
        }}
      >
          <>
            <ToolbarBtn
              onClick={() => ctx.addTab(getCwd(), "Claude Code", true)}
              title="Launch Claude Code (Ctrl+Shift+C)"
              variant="success"
            >
              Claude
            </ToolbarBtn>
            <ToolbarBtn
              onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
              title="Launch Shell (Ctrl+Shift+Z)"
              variant="primary"
            >
              Shell
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
            <div style={{ width: 1, height: 18, background: "var(--border)", margin: "0 4px" }} />
            <ThemePickerButton />
          </>
      </div>
      )}
    </div>
  );
}

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
  const getCwd = () => ctx.sidebarSelectedPath ?? defaultCwd;
  const focusedPaneId = ctx.focusedPaneId;
  const actionBackground = `color-mix(in srgb, ${foreground} 9%, transparent)`;
  const actionBorder = `color-mix(in srgb, ${foreground} 18%, transparent)`;

  return (
    <div
      data-testid="terminal-mobile-actions"
      role="toolbar"
      aria-label="Mobile terminal actions"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        overflowX: "auto",
        padding: "6px 2px 4px",
        background,
        borderTop: `1px solid ${actionBorder}`,
        scrollbarWidth: "none",
        WebkitOverflowScrolling: "touch",
        flexShrink: 0,
      }}
    >
      <MobileActionButton
        label="Shell"
        title="Open mobile shell"
        icon={<TerminalIcon size={14} strokeWidth={1.8} />}
        onClick={() => { void ctx.createShellSessionTab("Mobile Shell", getCwd()); }}
        background={accent}
        foreground="var(--primary-foreground)"
        border="transparent"
      />
      <MobileActionButton
        label="Pane"
        title="Split pane below"
        icon={<Rows2Icon size={14} strokeWidth={1.8} />}
        onClick={() => { if (focusedPaneId) ctx.splitPane(focusedPaneId, "vertical"); }}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
      />
      <MobileActionButton
        label="Tab"
        title="Open terminal tab"
        icon={<PlusIcon size={14} strokeWidth={1.8} />}
        onClick={() => { void ctx.createShellSessionTab("Shell", getCwd()); }}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
      />
      <MobileActionButton
        label="Cmd"
        title="Open Claude Code"
        icon={<KeyboardIcon size={14} strokeWidth={1.8} />}
        onClick={() => ctx.addTab(getCwd(), "Claude Code", true)}
        background={actionBackground}
        foreground={foreground}
        border={actionBorder}
      />
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
  title,
  icon,
  onClick,
  background,
  foreground,
  border,
  minWidth = 56,
}: {
  label: string;
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
      aria-label={label}
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
}: {
  onSend: (data: string) => void;
  background: string;
  foreground: string;
  accent: string;
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
        spellCheck={false}
        style={{
          background: `color-mix(in srgb, ${foreground} 8%, transparent)`,
          border: `1px solid ${border}`,
          borderRadius: 9,
          color: foreground,
          flex: "1 1 auto",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 13,
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
          color: "#15180F",
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

interface ProjectInfo {
  name: string;
  path: string;
  isGit: boolean;
  branch: string | null;
  dirtyCount: number;
  modified: string | null;
}

type SidebarTab = "projects" | "shells" | "sessions" | "files";
type NewSessionMenuAnchor = "drawer" | "rail";

interface ShellSessionSummary {
  name: string;
  status?: "active" | "exited" | "degraded";
  placement?: "active" | "background";
  updatedAt?: string;
  attachedClients?: number;
  latestSeq?: number | null;
  lastSeenSeq?: number | null;
  unread?: boolean;
  visualStatus?: "running" | "waiting" | "finished" | "idle";
  attachCommand?: string;
  tabs?: Array<{ idx: number; name?: string; focused?: boolean }>;
}

type ShellUiStatePatch = Partial<Pick<ShellSessionSummary, "placement" | "lastSeenSeq" | "visualStatus">>;
type ShellUiStatePatchKey = keyof ShellUiStatePatch;

const SHELL_UI_STATE_PATCH_KEYS: ShellUiStatePatchKey[] = ["placement", "lastSeenSeq", "visualStatus"];

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

function shellSessionsEqual(left: ShellSessionSummary[], right: ShellSessionSummary[]): boolean {
  return left.length === right.length && left.every((session, index) => {
    const next = right[index];
    if (!next) return false;
    if (
      session.name !== next.name ||
      session.status !== next.status ||
      session.placement !== next.placement ||
      session.updatedAt !== next.updatedAt ||
      session.attachedClients !== next.attachedClients ||
      session.latestSeq !== next.latestSeq ||
      session.lastSeenSeq !== next.lastSeenSeq ||
      session.unread !== next.unread ||
      session.visualStatus !== next.visualStatus ||
      session.attachCommand !== next.attachCommand
    ) {
      return false;
    }
    const tabs = session.tabs ?? [];
    const nextTabs = next.tabs ?? [];
    if (tabs.length !== nextTabs.length) return false;
    return tabs.every((tab, tabIndex) => {
      const nextTab = nextTabs[tabIndex];
      if (!nextTab) return false;
      return (
        tab.idx === nextTab.idx &&
        tab.name === nextTab.name &&
        tab.focused === nextTab.focused
      );
    });
  });
}

function getShellTabCount(shell: ShellSessionSummary): number | null {
  if (!Array.isArray(shell.tabs)) return null;
  return shell.tabs.reduce((count, tab) => {
    const indexedCount = Number.isInteger(tab.idx) && tab.idx >= 0 ? tab.idx + 1 : 0;
    return Math.max(count, indexedCount);
  }, shell.tabs.length);
}

function formatShellTabCount(shell: ShellSessionSummary): string {
  const count = getShellTabCount(shell);
  if (count === null) return "tabs unknown";
  return `${count} tab${count === 1 ? "" : "s"}`;
}

function formatShellDisplayName(name: string): string {
  return name === DEFAULT_SHELL_SESSION_NAME ? "matrix-main" : name;
}

const COLLAPSED_RAIL_ITEM_SIZE = 40;

function formatCollapsedShellLabel(name: string): string {
  const normalized = formatShellDisplayName(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const parts = normalized.split("-").filter(Boolean);
  const compact = parts.join("");
  let label = "";
  if (parts.length >= 2) {
    label = `${parts[0]?.charAt(0) ?? ""}${parts[1]?.slice(0, 2) ?? ""}`;
  } else {
    label = compact.slice(0, 3);
  }
  if (label.length >= 3) {
    return label.slice(0, 3);
  }
  const fallback = (compact || "shl").slice(label.length);
  const padded = `${label}${fallback}`;
  return padded.padEnd(3, padded.at(-1) ?? "l").slice(0, 3);
}

function shellConnectCommand(name: string): string {
  return `matrix shell connect ${name}`;
}

function shellAttachCommand(shell: ShellSessionSummary): string {
  return shellConnectCommand(shell.name);
}

function getShellUiStatePatchKeys(patch: ShellUiStatePatch): ShellUiStatePatchKey[] {
  return SHELL_UI_STATE_PATCH_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(patch, key));
}

function deriveShellUnread(shell: ShellSessionSummary): ShellSessionSummary {
  if (shell.latestSeq === undefined || shell.latestSeq === null || shell.lastSeenSeq === undefined || shell.lastSeenSeq === null) {
    return shell;
  }
  return { ...shell, unread: shell.latestSeq > shell.lastSeenSeq };
}

function applyShellUiStatePatch(shell: ShellSessionSummary, patch: ShellUiStatePatch): ShellSessionSummary {
  return deriveShellUnread({ ...shell, ...patch });
}

function snapshotShellUiStatePatchValue(
  previousValues: ShellUiStatePatch,
  shell: ShellSessionSummary,
  key: ShellUiStatePatchKey,
): void {
  switch (key) {
    case "placement":
      previousValues.placement = shell.placement;
      return;
    case "lastSeenSeq":
      previousValues.lastSeenSeq = shell.lastSeenSeq;
      return;
    case "visualStatus":
      previousValues.visualStatus = shell.visualStatus;
      return;
    default: {
      const unhandledKey: never = key;
      throw new Error(`Unhandled shell UI state patch key: ${String(unhandledKey)}`);
    }
  }
}

function snapshotShellUiStatePatch(shell: ShellSessionSummary, patch: ShellUiStatePatch): ShellUiStatePatch {
  const previousValues: ShellUiStatePatch = {};
  for (const key of getShellUiStatePatchKeys(patch)) {
    snapshotShellUiStatePatchValue(previousValues, shell, key);
  }
  return previousValues;
}

function rollbackShellUiStatePatchValue(
  shell: ShellSessionSummary,
  patch: ShellUiStatePatch,
  previousValues: ShellUiStatePatch,
  key: ShellUiStatePatchKey,
): ShellSessionSummary {
  switch (key) {
    case "placement":
      return Object.is(shell.placement, patch.placement)
        ? { ...shell, placement: previousValues.placement }
        : shell;
    case "lastSeenSeq":
      return Object.is(shell.lastSeenSeq, patch.lastSeenSeq)
        ? { ...shell, lastSeenSeq: previousValues.lastSeenSeq }
        : shell;
    case "visualStatus":
      return Object.is(shell.visualStatus, patch.visualStatus)
        ? { ...shell, visualStatus: previousValues.visualStatus }
        : shell;
    default: {
      const unhandledKey: never = key;
      throw new Error(`Unhandled shell UI state patch key: ${String(unhandledKey)}`);
    }
  }
}

function rollbackShellUiStatePatch(
  shell: ShellSessionSummary,
  patch: ShellUiStatePatch,
  previousValues: ShellUiStatePatch,
): ShellSessionSummary {
  let next = shell;
  for (const key of getShellUiStatePatchKeys(patch)) {
    next = rollbackShellUiStatePatchValue(next, patch, previousValues, key);
  }
  return deriveShellUnread(next);
}

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

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/prefer-useReducer -- no-giant-component: cohesive core terminal sidebar component; extraction tracked separately. prefer-useReducer: the 15 useState fields are several independent clusters, not one related cluster: projects/shells/sessions/files each carry their own data+loading+error triplet with separate fetch lifecycles, plus orthogonal tab/filter/rootPath/tree UI state; collapsing them into one reducer would obscure the independent update sites and would not be a mechanical, behavior-identical change.
function LocalTerminalSidebar() {
  const ctx = useTerminalAppContext();
  const [tab, setTab] = useState<SidebarTab>("shells");
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [shells, setShells] = useState<ShellSessionSummary[]>([]);
  const [shellsAuthoritative, setShellsAuthoritative] = useState(false);
  const [shellsLoading, setShellsLoading] = useState(false);
  const [shellsError, setShellsError] = useState<string | null>(null);
  const creatingShellRef = useRef(false);
  const reorderSaveCountRef = useRef(0);
  const [creatingShell, setCreatingShell] = useState(false);
  const deletingShellsRef = useRef<Set<string> | null>(null);
  if (deletingShellsRef.current === null) deletingShellsRef.current = new Set();
  const [deletingShellNames, setDeletingShellNames] = useState<string[]>([]);
  const [closeConfirmationShell, setCloseConfirmationShell] = useState<ShellSessionSummary | null>(null);
  const [newSessionMenuAnchor, setNewSessionMenuAnchor] = useState<NewSessionMenuAnchor | null>(null);
  const [draggingShellName, setDraggingShellName] = useState<string | null>(null);
  const [dragOverShellName, setDragOverShellName] = useState<string | null>(null);
  const [draggingShellPlacement, setDraggingShellPlacement] = useState<"active" | "background" | null>(null);
  const [sessions, setSessions] = useState<WorkspaceSessionSummary[]>([]);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
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
        if (!silent) {
          setShellsError("Failed to load shells");
        }
        return;
      }
      if (options.preserveOrderDuringReorder === true && reorderSaveCountRef.current > 0) {
        return;
      }
      const data = (await res.json()) as { sessions?: ShellSessionSummary[] };
      const hasSessionList = Array.isArray(data.sessions);
      const nextShells = hasSessionList ? data.sessions! : [];
      setShellsAuthoritative(hasSessionList);
      setShells((prev) => shellSessionsEqual(prev, nextShells) ? prev : nextShells);
      setShellsError(null);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (silent) return;
      console.warn("Failed to load shell sessions:", err instanceof Error ? err.message : err);
      setShellsError("Could not reach gateway");
    } finally {
      if (!silent) setShellsLoading(false);
    }
  }, []);

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

  const patchShellUiState = async (name: string, patch: ShellUiStatePatch) => {
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
        setShellsError("Failed to update session");
        rollback();
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
      setShellsError("Could not update session");
      rollback();
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
  const drawerWidth = ctx.mobile ? "100%" : 392;
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
    });
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
        setShells((prev) => shellSessionsEqual(prev, data.sessions!) ? prev : data.sessions!);
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
    setNewSessionMenuAnchor((current) => current === anchor ? null : anchor);
  };

  const createClaudeCodeSession = () => {
    setNewSessionMenuAnchor(null);
    ctx.addTab(ctx.sidebarSelectedPath ?? DEFAULT_CWD, "Claude Code", true);
    if (ctx.mobile) {
      ctx.setSidebarOpen(false);
    }
  };

  const createCodexSession = () => {
    setNewSessionMenuAnchor(null);
    ctx.addTab(ctx.sidebarSelectedPath ?? DEFAULT_CWD, "Codex", false, "codex");
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
            overflow: "hidden",
            transform: "translateX(0)",
            transition: TERMINAL_SIDEBAR_TRANSITION,
            width: 76,
          }}
        >
          <CollapsedSessionsRail
            shells={unfilteredRenderedShells}
            selectedShellName={activeShellName}
            onExpand={() => ctx.setSidebarOpen(true)}
            creatingShell={creatingShell}
            newSessionMenuOpen={newSessionMenuAnchor === "rail"}
            onNew={() => openNewSessionMenu("rail")}
            onNewMenuClose={() => setNewSessionMenuAnchor(null)}
            onCreateShell={() => void createManagedShell()}
            onCreateClaude={createClaudeCodeSession}
            onCreateCodex={createCodexSession}
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
          background: "#E9E9D8",
          borderRight: ctx.mobile ? "none" : "1px solid #D6D5C4",
          borderBottom: ctx.mobile ? "1px solid #D6D5C4" : "none",
          color: "#31362D",
          display: "flex",
          flexDirection: "column",
          maxHeight: ctx.mobile ? "52%" : undefined,
          minHeight: ctx.mobile ? 360 : undefined,
          opacity: 1,
          transform: "translateX(0)",
          transition: ctx.mobile ? undefined : TERMINAL_SIDEBAR_TRANSITION,
          width: drawerWidth,
        }}
      >
      <div
        className="shrink-0"
        style={{
          borderBottom: "1px solid #D6D5C4",
          display: "flex",
          flexDirection: "column",
          gap: 18,
          padding: ctx.mobile ? "16px 20px" : "19px 24px 18px",
        }}
      >
        <div className="flex items-center justify-between" style={{ gap: 16 }}>
          <div className="flex min-w-0 items-start" style={{ gap: 12 }}>
            <div
              className="flex shrink-0 items-center justify-center"
              style={{
                background: "#465243",
                borderRadius: ctx.mobile ? 12 : 9,
                color: "#F8F7EF",
                fontFamily: "Orbitron, system-ui, sans-serif",
                fontSize: ctx.mobile ? 17 : 15,
                fontWeight: 800,
                height: ctx.mobile ? 40 : 30,
                width: ctx.mobile ? 40 : 30,
              }}
            >
              M
            </div>
            <div className="min-w-0">
              <div style={{ color: "#3E4339", fontFamily: "Orbitron, system-ui, sans-serif", fontSize: 20, fontWeight: 800, lineHeight: "24px" }}>
                matrixos
              </div>
              {!ctx.mobile ? (
                <div className="truncate" style={{ color: "#858578", fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 13, lineHeight: "17px" }}>
                  {ctx.sidebarSelectedPath ? formatCwd(ctx.sidebarSelectedPath) : "~/projects"}
                </div>
              ) : null}
            </div>
          </div>
          <div className="flex shrink-0 items-center" style={{ gap: 10 }}>
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
                  background: "#465243",
                  border: 0,
                  borderRadius: ctx.mobile ? 13 : 10,
                  color: "#F8F7EF",
                  cursor: creatingShell ? "not-allowed" : "pointer",
                  fontSize: 25,
                  height: ctx.mobile ? 44 : 40,
                  lineHeight: "28px",
                  opacity: creatingShell ? 0.72 : 1,
                  width: ctx.mobile ? 44 : 40,
                }}
              >
                <PlusIcon aria-hidden="true" size={ctx.mobile ? 20 : 18} strokeWidth={2.5} />
              </button>
              {newSessionMenuAnchor === "drawer" ? (
                <NewSessionMenu
                  align="right"
                  onClose={() => setNewSessionMenuAnchor(null)}
                  onCreateShell={() => void createManagedShell()}
                  onCreateClaude={createClaudeCodeSession}
                  onCreateCodex={createCodexSession}
                />
              ) : null}
            </div>
            {!ctx.mobile && (
              <>
                <button
                  type="button"
                  aria-label="Refresh sessions"
                  onClick={() => void fetchShells()}
                  disabled={shellsLoading}
                  className="flex items-center justify-center"
                  style={{
                    background: "#FFFDF7",
                    border: "1px solid #D6D5C4",
                    borderRadius: 10,
                    color: "#6F7167",
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
                    background: "#FFFDF7",
                    border: "1px solid #D6D5C4",
                    borderRadius: 10,
                    color: "#6F7167",
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
            background: "#FFFDF7",
            border: "1px solid #D6D5C4",
            borderRadius: ctx.mobile ? 14 : 10,
            gap: 10,
            height: ctx.mobile ? 48 : 40,
            padding: "0 14px",
          }}
        >
          <SearchIcon size={18} strokeWidth={1.9} color="#A09F92" />
          <input
            aria-label="Search sessions"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a session..."
            style={{
              background: "transparent",
              border: 0,
              color: "#31362D",
              flex: 1,
              fontSize: ctx.mobile ? 16 : 15,
              minWidth: 0,
            }}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" style={{ display: "flex", flexDirection: "column", gap: 18, padding: ctx.mobile ? 20 : 18 }}>
        {shellsLoading && (
          <div style={{ color: "#858578", fontSize: 12, padding: "24px 0", textAlign: "center" }}>Loading sessions...</div>
        )}
        {!shellsLoading && shellsError && (
          <div style={{ color: "#8F6712", fontSize: 12, padding: "24px 0", textAlign: "center" }}>{shellsError}</div>
        )}
        {!shellsLoading && !shellsError && !creatingShell && renderedShells.length === 0 && (
          <div style={{ color: "#858578", fontSize: 12, padding: "24px 0", textAlign: "center" }}>
            {filter ? "No sessions match" : "No sessions yet"}
          </div>
        )}
        {!shellsLoading && (activeShells.length > 0 || creatingShell) && (
          <ShellSessionGroup
            label="Active"
            meta={`${activeShells.length} attached`}
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
            meta={`${backgroundShells.length} detached`}
            shells={backgroundShells}
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

function NewSessionMenu({
  align,
  onClose,
  onCreateShell,
  onCreateClaude,
  onCreateCodex,
}: {
  align: "left" | "right";
  onClose: () => void;
  onCreateShell: () => void;
  onCreateClaude: () => void;
  onCreateCodex: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="New session menu"
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      style={{
        background: "#FFFDF7",
        border: "1px solid #D6D5C4",
        borderRadius: 10,
        boxShadow: "0 20px 45px rgba(39, 40, 34, 0.18)",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 10,
        position: "absolute",
        ...(align === "right"
          ? { right: -4, top: "calc(100% + 8px)" }
          : { left: "calc(100% + 8px)", top: 0 }),
        width: 248,
        zIndex: 70,
      }}
    >
      <div style={{ paddingBottom: 2 }}>
        <div
          style={{
            color: "#A09F92",
            fontFamily: "Inter, system-ui, sans-serif",
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: "0.1em",
            lineHeight: "16px",
            textTransform: "uppercase",
          }}
        >
          NEW TAB
        </div>
      </div>
      <NewSessionMenuItem
        label="Shell"
        shortcut="⌘T"
        active
        icon={(
          <TerminalIcon
            aria-hidden="true"
            size={20}
            strokeWidth={2.1}
            style={{ color: "#465243", flexShrink: 0 }}
          />
        )}
        onClick={onCreateShell}
      />
      <NewSessionMenuItem
        label="Claude Code"
        shortcut="⌘⇧C"
        icon={<span aria-hidden="true" style={{ background: "#D8792C", borderRadius: 5, flexShrink: 0, height: 18, width: 18 }} />}
        onClick={onCreateClaude}
      />
      <NewSessionMenuItem
        label="Codex"
        shortcut="⌘⇧X"
        icon={<span aria-hidden="true" style={{ background: "#465243", borderRadius: 5, flexShrink: 0, height: 18, width: 18 }} />}
        onClick={onCreateCodex}
      />
    </div>
  );
}

function NewSessionMenuItem({
  label,
  shortcut,
  icon,
  active = false,
  onClick,
}: {
  label: string;
  shortcut: string;
  icon: React.ReactNode;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        alignItems: "center",
        background: active ? "#F0EFE5" : "transparent",
        border: 0,
        borderRadius: active ? 8 : 6,
        boxSizing: "border-box",
        color: "#31362D",
        cursor: "pointer",
        display: "flex",
        flexShrink: 0,
        gap: 10,
        height: active ? 36 : 34,
        padding: "0 10px",
        textAlign: "left",
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "#F0EFE5";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = active ? "#F0EFE5" : "transparent";
      }}
    >
      {icon}
      <span
        style={{
          flex: "1 1 auto",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: 16,
          fontWeight: active ? 700 : 600,
          lineHeight: "20px",
          minWidth: 0,
        }}
      >
        {label}
      </span>
      <span
        style={{
          color: "#A09F92",
          flex: "0 0 46px",
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 12,
          lineHeight: "16px",
          textAlign: "right",
        }}
      >
        {shortcut}
      </span>
    </button>
  );
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
                fontSize: 11,
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
                fontSize: 11,
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
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex items-center justify-center cursor-pointer transition-colors"
      style={{
        ...SIDEBAR_RAIL_BUTTON_BASE_STYLE,
        border: `1px solid ${active ? "var(--border)" : "transparent"}`,
        background: active ? "var(--card)" : "transparent",
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
        boxShadow: active ? "0 1px 0 rgba(0,0,0,0.08)" : "none",
      }}
      title={label}
    >
      {icon}
    </button>
  );
}

function getShellVisualStatus(shell: ShellSessionSummary): NonNullable<ShellSessionSummary["visualStatus"]> {
  if (shell.visualStatus) return shell.visualStatus;
  if (shell.status === "degraded") return "waiting";
  if (shell.status === "exited") return shell.unread ? "finished" : "idle";
  return shell.unread ? "finished" : "idle";
}

function getShellStatusDotStyle(shell: ShellSessionSummary): CSSProperties {
  const status = getShellVisualStatus(shell);
  if (status === "running") {
    return { background: "#5FB85F", boxShadow: "0 0 0 4px rgba(95,184,95,0.24)" };
  }
  if (status === "waiting") {
    return { background: "#E0A12E", boxShadow: "0 0 0 4px rgba(224,161,46,0.25)" };
  }
  if (status === "finished") {
    return { background: "#2E6B3A", boxShadow: "none" };
  }
  return { background: "#A9AA9A", boxShadow: "none" };
}

function getShellStatusDotClassName(shell: ShellSessionSummary): string {
  return getShellVisualStatus(shell) === "running"
    ? "terminal-session-status-dot terminal-session-status-dot--running"
    : "terminal-session-status-dot";
}

function CollapsedSessionsRail({
  shells,
  selectedShellName,
  onExpand,
  creatingShell,
  newSessionMenuOpen,
  onNew,
  onNewMenuClose,
  onCreateShell,
  onCreateClaude,
  onCreateCodex,
  onOpen,
}: {
  shells: ShellSessionSummary[];
  selectedShellName: string | null;
  onExpand: () => void;
  creatingShell: boolean;
  newSessionMenuOpen: boolean;
  onNew: () => void;
  onNewMenuClose: () => void;
  onCreateShell: () => void;
  onCreateClaude: () => void;
  onCreateCodex: () => void;
  onOpen: (shell: ShellSessionSummary) => void;
}) {
  const activeShells = shells.filter((shell) => shell.placement !== "background");
  const backgroundShells = shells.filter((shell) => shell.placement === "background");
  return (
    <aside
      data-testid="terminal-collapsed-rail"
      className="shrink-0"
      style={{
        alignItems: "center",
        background: "#E9E9D8",
        borderRight: "1px solid #D6D5C4",
        color: "#31362D",
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px 0",
        width: 76,
      }}
    >
      <div
        data-testid="terminal-collapsed-brand"
        className="flex items-center justify-center"
        style={{
          background: "#465243",
          borderRadius: 11,
          color: "#F8F7EF",
          flexShrink: 0,
          fontFamily: "Orbitron, system-ui, sans-serif",
          fontSize: 15,
          fontWeight: 800,
          height: COLLAPSED_RAIL_ITEM_SIZE,
          width: COLLAPSED_RAIL_ITEM_SIZE,
        }}
        title="matrixos"
      >
        M
      </div>
      <CollapsedRailButton label="Expand sessions drawer" onClick={onExpand}>
        <ChevronsRightIcon data-testid="terminal-drawer-expand-icon" size={17} strokeWidth={2} />
      </CollapsedRailButton>
      <div style={{ position: "relative" }}>
        <CollapsedRailButton label="New session" onClick={onNew} strong disabled={creatingShell} expanded={newSessionMenuOpen}>
          <PlusIcon aria-hidden="true" data-testid="terminal-collapsed-new-session-icon" size={18} strokeWidth={2.5} />
        </CollapsedRailButton>
        {newSessionMenuOpen ? (
          <NewSessionMenu
            align="left"
            onClose={onNewMenuClose}
            onCreateShell={onCreateShell}
            onCreateClaude={onCreateClaude}
            onCreateCodex={onCreateCodex}
          />
        ) : null}
      </div>
      <div style={{ background: "#D6D5C4", height: 1, width: 34 }} />
      <CollapsedRailGroup shells={activeShells} selectedShellName={selectedShellName} onOpen={onOpen} />
      {backgroundShells.length > 0 && (
        <>
          <div style={{ background: "#D6D5C4", height: 1, width: 34 }} />
          <CollapsedRailGroup shells={backgroundShells} selectedShellName={selectedShellName} onOpen={onOpen} muted />
        </>
      )}
    </aside>
  );
}

function CollapsedRailGroup({
  shells,
  selectedShellName,
  onOpen,
  muted = false,
}: {
  shells: ShellSessionSummary[];
  selectedShellName: string | null;
  onOpen: (shell: ShellSessionSummary) => void;
  muted?: boolean;
}) {
  return (
    <div className="flex flex-col items-center" style={{ gap: 9 }}>
      {shells.map((shell) => {
        const displayName = formatShellDisplayName(shell.name);
        const label = formatCollapsedShellLabel(shell.name);
        const selected = shell.name === selectedShellName;
        return (
          <button
            key={shell.name}
            type="button"
            aria-label={`Open ${displayName}`}
            aria-current={selected ? "true" : undefined}
            data-selected={selected ? "true" : "false"}
            title={displayName}
            onClick={() => onOpen(shell)}
            className="relative flex items-center justify-center"
            style={{
              background: selected ? "#FFFDF7" : muted ? "#E2E2D0" : "#FFFDF7",
              border: `1px solid ${selected ? "#9CB77A" : muted ? "#D4D2C1" : "#D6D5C4"}`,
              borderRadius: 11,
              boxShadow: selected ? "0 0 0 5px rgba(156,183,122,0.30), 0 8px 18px rgba(39,40,34,0.16)" : "none",
              color: muted ? "#858578" : "#31362D",
              cursor: "pointer",
              flexShrink: 0,
              fontFamily: "var(--font-mono, ui-monospace, monospace)",
              fontSize: 12,
              fontWeight: 700,
              height: COLLAPSED_RAIL_ITEM_SIZE,
              lineHeight: "14px",
              opacity: muted ? 0.82 : 1,
              overflow: "visible",
              width: COLLAPSED_RAIL_ITEM_SIZE,
            }}
          >
            {label}
            <span
              aria-hidden="true"
              className={getShellStatusDotClassName(shell)}
              data-testid={`terminal-session-status-${shell.name}`}
              style={{
                ...getShellStatusDotStyle(shell),
                border: "2px solid #E9E9D8",
                borderRadius: 999,
                boxSizing: "border-box",
                height: 12,
                position: "absolute",
                right: -3,
                top: -3,
                width: 12,
                zIndex: 1,
              }}
            />
          </button>
        );
      })}
    </div>
  );
}

function CollapsedRailButton({
  label,
  onClick,
  children,
  strong = false,
  disabled = false,
  expanded = false,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  strong?: boolean;
  disabled?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-haspopup={label === "New session" ? "menu" : undefined}
      aria-expanded={label === "New session" ? expanded : undefined}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center"
      style={{
        background: strong ? "#465243" : "#FFFDF7",
        border: strong ? "1px solid #465243" : "1px solid #D6D5C4",
        borderRadius: strong ? 11 : 10,
        color: strong ? "#F8F7EF" : "#6F7167",
        cursor: disabled ? "not-allowed" : "pointer",
        flexShrink: 0,
        fontSize: strong ? 24 : 14,
        fontWeight: 700,
        height: COLLAPSED_RAIL_ITEM_SIZE,
        lineHeight: 1,
        opacity: disabled ? 0.72 : 1,
        width: COLLAPSED_RAIL_ITEM_SIZE,
      }}
    >
      {children}
    </button>
  );
}

function ShellSessionGroup({
  label,
  meta,
  shells,
  pending = false,
  deletingShellNames,
  foreground,
  selectedShellName,
  onOpen,
  onToggle,
  onRename,
  onDelete,
  draggingShellName,
  dragOverShellName,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  label: "Active" | "Background";
  meta: string;
  shells: ShellSessionSummary[];
  pending?: boolean;
  deletingShellNames: string[];
  foreground: boolean;
  selectedShellName: string | null;
  onOpen: (shell: ShellSessionSummary) => void;
  onToggle: (shell: ShellSessionSummary) => void;
  onRename: (shell: ShellSessionSummary, nextName: string) => Promise<boolean>;
  onDelete: (shell: ShellSessionSummary) => void;
  draggingShellName: string | null;
  dragOverShellName: string | null;
  onDragStart: (shell: ShellSessionSummary) => void;
  onDragOver: (shell: ShellSessionSummary) => void;
  onDrop: (shell: ShellSessionSummary) => void;
  onDragEnd: () => void;
}) {
  return (
    <section data-testid={`terminal-session-group-${label.toLowerCase()}`} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="flex items-center justify-between" style={{ color: "#858578", minHeight: 22 }}>
        <div className="flex items-center" style={{ gap: 7 }}>
          {label === "Background" && (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#858578" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          )}
          <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", lineHeight: "14px", textTransform: "uppercase" }}>
            {label}
          </span>
        </div>
        <span style={{ fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12, lineHeight: "14px" }}>
          {meta}
        </span>
      </div>
      {pending ? <ShellPendingCard /> : null}
      {shells.length === 0 && !pending ? (
        <div style={{ color: "#A09F92", fontSize: 12, padding: "8px 0 6px" }}>
          {foreground ? "No active sessions" : "Nothing running in background"}
        </div>
      ) : shells.map((shell) => (
        <ShellCard
          key={`${label}-${shell.name}`}
          shell={shell}
          foreground={foreground}
          deleting={deletingShellNames.includes(shell.name)}
          selected={shell.name === selectedShellName}
          onOpen={() => onOpen(shell)}
          onToggle={() => onToggle(shell)}
          onRename={(nextName) => onRename(shell, nextName)}
          onDelete={() => onDelete(shell)}
          dragging={shell.name === draggingShellName}
          dropTarget={shell.name === dragOverShellName}
          onDragStart={() => onDragStart(shell)}
          onDragOver={() => onDragOver(shell)}
          onDrop={() => onDrop(shell)}
          onDragEnd={onDragEnd}
        />
      ))}
    </section>
  );
}

function ShellPendingCard() {
  return (
    <output
      aria-label="Creating shell session"
      data-testid="terminal-session-pending-row"
      style={{
        alignItems: "center",
        background: "#FFFDF7",
        border: "1px solid #D6D5C4",
        borderRadius: 10,
        boxShadow: "0 9px 22px rgba(39,40,34,0.10)",
        color: "#858578",
        display: "grid",
        gap: 10,
        gridTemplateColumns: "12px 8px minmax(0, 1fr) 58px 46px",
        height: 52,
        opacity: 0.82,
        padding: "0 12px",
      }}
    >
      <span style={{ width: 12 }} />
      <span
        aria-hidden="true"
        className="terminal-refresh-icon--loading"
        style={{
          border: "2px solid #D6D5C4",
          borderTopColor: "#465243",
          borderRadius: "50%",
          height: 8,
          width: 8,
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-mono, ui-monospace, monospace)",
          fontSize: 14,
          fontWeight: 700,
          lineHeight: "18px",
          minWidth: 0,
        }}
      >
        Creating session
      </span>
      <span />
      <span
        style={{
          background: "#F0EFE5",
          border: "1px solid #E4E2D2",
          borderRadius: 999,
          color: "#858578",
          fontSize: 12,
          fontWeight: 800,
          lineHeight: "18px",
          textAlign: "center",
        }}
      >
        NEW
      </span>
    </output>
  );
}

function ShellCard({
  shell,
  foreground,
  deleting,
  selected,
  onOpen,
  onToggle,
  onRename,
  onDelete,
  dragging,
  dropTarget,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  shell: ShellSessionSummary;
  foreground: boolean;
  deleting?: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onRename: (nextName: string) => Promise<boolean>;
  onDelete: () => void;
  dragging: boolean;
  dropTarget: boolean;
  onDragStart: () => void;
  onDragOver: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const statusDotStyle = getShellStatusDotStyle(shell);
  const [copyFeedback, setCopyFeedback] = useState<"copied" | "failed" | null>(null);
  const displayName = formatShellDisplayName(shell.name);
  const [actionsVisible, setActionsVisible] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(shell.name);
  const [renameSaving, setRenameSaving] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameCommittingRef = useRef(false);
  const copiedTimerRef = useRef<number | null>(null);
  const showActions = actionsVisible || copyFeedback !== null;
  const showRenameControl = foreground && actionsVisible && !renaming;
  const showDragHandle = (actionsVisible || dragging) && !renaming && !deleting;
  const renameControlLabel = `Rename ${displayName}`;

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (!renaming) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renaming]);

  const copyAttachCommand = async () => {
    try {
      await copyTextToClipboard(shellAttachCommand(shell));
      setCopyFeedback("copied");
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopyFeedback(null);
      }, 1200);
    } catch (err: unknown) {
      console.warn("Failed to copy shell connect command:", err instanceof Error ? err.message : err);
      setCopyFeedback("failed");
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopyFeedback(null);
      }, 1600);
    }
  };
  const cancelRename = useCallback(() => {
    setRenameDraft(shell.name);
    setRenaming(false);
  }, [shell.name]);

  const commitRename = useCallback(async (draft = renameDraft) => {
    const nextName = draft.trim();
    if (!nextName) {
      cancelRename();
      return;
    }
    if (renameSaving || renameCommittingRef.current) return;
    if (nextName === shell.name) {
      setRenaming(false);
      return;
    }
    renameCommittingRef.current = true;
    setRenameSaving(true);
    let renamed = false;
    try {
      renamed = await onRename(nextName);
    } catch (err: unknown) {
      console.warn("Failed to commit shell session rename:", err instanceof Error ? err.message : err);
    }
    if (renamed) {
      setRenaming(false);
    }
    renameCommittingRef.current = false;
    setRenameSaving(false);
  }, [cancelRename, onRename, renameDraft, renameSaving, shell.name]);

  const finishRename = useCallback(() => {
    if (renameCommittingRef.current) return;
    const nextDraft = renameInputRef.current?.value ?? renameDraft;
    if (nextDraft.trim() === shell.name || nextDraft.trim().length === 0) {
      cancelRename();
      return;
    }
    void commitRename(nextDraft);
  }, [cancelRename, commitRename, renameDraft, shell.name]);

  useEffect(() => {
    if (!renaming) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && cardRef.current?.contains(target)) {
        return;
      }
      finishRename();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [finishRename, renaming]);

  const handleCardClick = () => {
    if (renaming || renameSaving || deleting) return;
    onOpen();
  };

  return (
    <div
      ref={cardRef}
      className="group terminal-session-card"
      data-testid={`terminal-session-card-${shell.name}`}
      onDragOver={(event) => {
        if (!dragging) {
          event.preventDefault();
        }
        event.dataTransfer.dropEffect = "move";
        onDragOver();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDrop();
      }}
      onMouseEnter={() => setActionsVisible(true)}
      onMouseMove={() => setActionsVisible(true)}
      onMouseOver={() => setActionsVisible(true)}
      onMouseLeave={() => setActionsVisible(false)}
      onPointerEnter={() => setActionsVisible(true)}
      onPointerMove={() => setActionsVisible(true)}
      onPointerOver={() => setActionsVisible(true)}
      onPointerLeave={() => setActionsVisible(false)}
      onFocus={() => setActionsVisible(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setActionsVisible(false);
        }
      }}
      style={{
        background: selected ? "#FFFDF7" : foreground ? "#FFFDF7" : "#E2E2D0",
        border: `1px solid ${selected ? "#9CB77A" : foreground ? "#D6D5C4" : "#D4D2C1"}`,
        borderRadius: 10,
        boxShadow: dragging
          ? "0 18px 34px rgba(39,40,34,0.22)"
          : selected
            ? "0 0 0 5px rgba(156,183,122,0.28), 0 14px 30px rgba(39,40,34,0.18)"
            : foreground ? "0 9px 22px rgba(39,40,34,0.13)" : "none",
        cursor: renaming || deleting ? "default" : "pointer",
        alignItems: "center",
        display: "grid",
        gap: 10,
        gridTemplateColumns: "minmax(0, 1fr) 46px",
        height: 52,
        opacity: dragging ? 0.94 : foreground ? 1 : 0.86,
        padding: "0 12px",
        position: "relative",
        transform: dragging ? "translateY(-2px)" : "translateY(0)",
        transition: "border-color 150ms ease, box-shadow 150ms ease, opacity 120ms ease, transform 150ms ease",
      }}
    >
      {dropTarget && (
        <span
          aria-hidden="true"
          data-testid={`terminal-session-drop-line-${shell.name}`}
          style={{
            background: "#D8792C",
            borderRadius: 999,
            height: 3,
            left: 12,
            position: "absolute",
            right: 12,
            top: -7,
            zIndex: 3,
          }}
        />
      )}
      {selected && (
        <span
          aria-hidden="true"
          style={{
            background: "#465243",
            borderRadius: 999,
            bottom: 12,
            left: -1,
            position: "absolute",
            top: 12,
            width: 3,
            zIndex: 2,
          }}
        />
      )}
      {!renaming && !deleting && (
        <button
          type="button"
          data-testid={`terminal-session-row-${shell.name}`}
          aria-current={selected ? "true" : undefined}
          aria-label={`Show ${displayName} session`}
          data-selected={selected ? "true" : "false"}
          onClick={handleCardClick}
          style={{
            background: "transparent",
            border: 0,
            borderRadius: 10,
            cursor: "pointer",
            inset: 0,
            padding: 0,
            position: "absolute",
            zIndex: 0,
          }}
        />
      )}
      <div
        className="min-w-0"
        style={{
          alignItems: "center",
          display: "grid",
          gap: 10,
          gridTemplateColumns: "12px 8px minmax(0, 1fr)",
          pointerEvents: "none",
          position: "relative",
          zIndex: 1,
        }}
      >
        <button
          type="button"
          aria-label={`Drag ${displayName} session`}
          draggable={!renaming && !deleting}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onDragStart={(event) => {
            event.stopPropagation();
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", shell.name);
            onDragStart();
          }}
          onDragEnd={(event) => {
            event.stopPropagation();
            onDragEnd();
          }}
          className="flex items-center justify-center"
          style={{
            background: "transparent",
            border: 0,
            color: "#A09F92",
            cursor: showDragHandle ? "grab" : "default",
            flexShrink: 0,
            height: 18,
            opacity: showDragHandle ? 1 : 0,
            padding: 0,
            pointerEvents: "auto",
            transition: "opacity 120ms ease",
            width: 12,
          }}
        >
          <GripVerticalIcon size={12} strokeWidth={2.1} />
        </button>
        <span
          className={getShellStatusDotClassName(shell)}
          data-testid={`terminal-session-status-${shell.name}`}
          style={{
            width: foreground ? 7 : 8,
            height: foreground ? 7 : 8,
            borderRadius: "50%",
            flexShrink: 0,
            ...statusDotStyle,
          }}
          />
        <div
          className="min-w-0"
          style={{
            alignItems: "center",
            display: "grid",
            gap: 6,
            gridTemplateColumns: renaming ? "minmax(0, 1fr)" : foreground ? "minmax(0, 1fr) 22px 58px" : "minmax(0, 1fr) 58px",
          }}
        >
          {renaming ? (
            <input
              ref={renameInputRef}
              aria-label={`Session name for ${displayName}`}
              value={renameDraft}
              disabled={renameSaving}
              onChange={(event) => setRenameDraft(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onBlur={finishRename}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
              style={{
                background: "#FFFDF7",
                border: "1px solid #D6D5C4",
                borderRadius: 6,
                color: "#31362D",
                flex: "1 1 auto",
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: 14,
                fontWeight: 700,
                height: 24,
                lineHeight: "18px",
                minWidth: 0,
                outline: "none",
                padding: "0 6px",
                pointerEvents: "auto",
              }}
            />
          ) : (
            <button
              type="button"
              data-session-name={shell.name}
              data-testid={`terminal-session-name-${shell.name}`}
              aria-label={`Open ${displayName}`}
              className="min-w-0 truncate"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
              style={{
                background: "transparent",
                border: 0,
                color: foreground ? "#31362D" : "#5F6258",
                cursor: "pointer",
                fontFamily: "var(--font-mono, ui-monospace, monospace)",
                fontSize: 14,
                fontWeight: 700,
                lineHeight: "18px",
                minWidth: 0,
                padding: 0,
                pointerEvents: "auto",
                textAlign: "left",
              }}
            >
              {displayName}
            </button>
          )}
          {foreground && !renaming && (
            <button
              type="button"
              aria-label={renameControlLabel}
              title={renameControlLabel}
              disabled={renameSaving}
              onClick={(event) => {
                event.stopPropagation();
                setRenameDraft(shell.name);
                setRenaming(true);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              className="flex items-center justify-center"
              style={{
                ...SESSION_RENAME_BUTTON_STYLE,
                cursor: renameSaving ? "not-allowed" : "pointer",
                opacity: showRenameControl ? 1 : 0,
              }}
            >
              <PencilIcon size={12} strokeWidth={2} />
            </button>
          )}
          {!renaming && (
            <div
              data-testid={`terminal-session-actions-${shell.name}`}
              aria-hidden={showActions ? undefined : "true"}
              className="flex shrink-0 items-center justify-end"
              style={{
                ...SESSION_ACTIONS_STYLE,
                opacity: showActions ? 1 : 0,
                pointerEvents: showActions ? "auto" : "none",
              }}
            >
              <button
                type="button"
                data-testid={`terminal-session-copy-button-${shell.name}`}
                aria-label={`Copy connect command for ${displayName}`}
                title={copyFeedback === "copied" ? "Copied" : shellConnectCommand(shell.name)}
                tabIndex={showActions ? 0 : -1}
                onClick={(event) => {
                  event.stopPropagation();
                  void copyAttachCommand();
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                className="flex items-center justify-center"
                style={{
                  ...SESSION_COPY_BUTTON_STYLE,
                  color: copyFeedback === "copied" ? "#465243" : "#8A8B7C",
                }}
              >
                {copyFeedback === "copied" ? (
                  <>
                    <CheckIcon size={12} strokeWidth={2.2} />
                    <output
                      data-testid={`terminal-session-copy-toast-${shell.name}`}
                      aria-live="polite"
                      style={SESSION_COPY_TOAST_STYLE}
                    >
                      Copied
                    </output>
                  </>
                ) : (
                  <LinkIcon size={12} strokeWidth={2.1} />
                )}
              </button>
              <button
                type="button"
                aria-label={`${deleting ? "Deleting" : "Close"} ${displayName}`}
                tabIndex={showActions ? 0 : -1}
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
                disabled={deleting}
                className="flex shrink-0 items-center justify-center"
                style={{
                  ...SESSION_CLOSE_BUTTON_STYLE,
                  cursor: deleting ? "not-allowed" : "pointer",
                  opacity: deleting ? 0.65 : 1,
                }}
              >
                ×
              </button>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label={foreground ? `Move ${displayName} to background` : `Make ${displayName} active`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          style={foreground ? ACTIVE_SHELL_TOGGLE_STYLE : BACKGROUND_SHELL_TOGGLE_STYLE}
        >
          {foreground && <span style={{ background: "#4F8A55", borderRadius: 999, height: 12, width: 12 }} />}
          <span style={{ flex: "1 1 auto", fontSize: 10, fontWeight: 800, lineHeight: "10px", textAlign: "center" }}>
            {foreground ? "ON" : "BG"}
          </span>
          {!foreground && <span style={{ background: "#F7F6EC", border: "1px solid #D6D5C4", borderRadius: 999, height: 12, width: 12 }} />}
        </button>
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
  disabled,
}: {
  label: string;
  sessionId: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={`${label} ${sessionId}`}
      onClick={onClick}
      disabled={disabled}
      className="text-[10px] cursor-pointer transition-colors"
      style={{
        padding: "2px 6px",
        borderRadius: 3,
        background: danger ? "var(--destructive)" : "var(--card)",
        color: danger ? "white" : "var(--foreground)",
        border: danger ? "none" : "1px solid var(--border)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.65 : 1,
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
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- cannot be a native <button>: this selectable card contains nested interactive <button> children (shell and agent actions), and nesting a button inside a button is invalid HTML; role="button" + tabIndex + keyboard handler is the correct accessible pattern here.
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      aria-label={`Select project ${project.name}`}
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
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
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
          <span style={PROJECT_BRANCH_BADGE_STYLE}>
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
          // react-doctor-disable-next-line react-doctor/no-layout-transition-inline -- intentional max-height collapse so the hover action row reclaims its vertical space when not active and the project list stays compact; transform/opacity cannot reclaim layout space, and the transition is a short bounded 120ms micro-reveal
          transition: "opacity 120ms, max-height 120ms",
        }}
      >
        <ProjectActionBtn label="Shell" onClick={(e) => { e.stopPropagation(); onOpenShell(); }} />
        <ProjectActionBtn label="Claude" onClick={(e) => { e.stopPropagation(); onOpenClaude(); }} accent="var(--success)" />
        <ProjectActionBtn label="Session" onClick={(e) => { e.stopPropagation(); onOpenZellij(); }} accent="var(--primary)" />
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
      type="button"
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

function filterTreeNodes(nodes: TreeNode[], normalizedFilter: string): TreeNode[] {
  return nodes.flatMap((node) => {
    const children = node.children ? filterTreeNodes(node.children, normalizedFilter) : [];
    const matches = [
      node.name,
      node.path,
      node.gitStatus,
    ].filter(Boolean).join(" ").toLowerCase().includes(normalizedFilter);

    if (matches) {
      return [{ ...node, expanded: node.type === "directory" ? true : node.expanded }];
    }
    if (children.length > 0) {
      return [{ ...node, children, expanded: true }];
    }
    return [];
  });
}

function TreeItem({ node, depth, selectedPath, onToggle, onSelect, onOpenTerminal }: { node: TreeNode; depth: number; selectedPath: string | null; onToggle: (n: TreeNode) => void; onSelect: (n: TreeNode) => void; onOpenTerminal: (path: string) => void }) {
  const rowStyle = {
    paddingLeft: 8 + depth * 12,
    background: selectedPath === node.path ? "var(--accent)" : undefined,
    color: (node.gitStatus && GIT_COLORS[node.gitStatus]) ?? "var(--foreground)",
  };
  const rowContent = (
    <>
      {node.type === "directory" ? <span className="text-[10px] opacity-60" style={{ width: 10 }}>{node.expanded ? "▾" : "▸"}</span> : <span style={{ width: 10 }} />}
      <span className="truncate flex-1">{node.name}</span>
      {node.type === "directory" && (node.changedCount ?? 0) > 0 && <span className="text-[9px] px-1 rounded" style={{ background: "var(--warning)", color: "var(--card)", opacity: 0.8 }}>{node.changedCount}</span>}
    </>
  );

  if (node.type !== "directory") {
    return (
      <div
        aria-label={node.name}
        className="w-full text-left flex items-center gap-1 px-2 py-0.5"
        style={rowStyle}
      >
        {rowContent}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label={node.name}
        className="w-full text-left flex items-center gap-1 px-2 py-0.5 cursor-pointer hover:bg-[var(--accent)] transition-colors"
        style={rowStyle}
        onClick={() => { if (node.type === "directory") { onToggle(node); onSelect(node); } }}
        onDoubleClick={() => { if (node.type === "directory") onOpenTerminal(node.path); }}
      >
        {rowContent}
      </button>
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
