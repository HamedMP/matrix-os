"use client";

export const BROWSER_MOBILE_SHELL_STATE_STORAGE_KEY = "matrix.mobileShellState.v1";

export type BrowserMobileShellSurface = "browser-shell" | "native-mobile";
export type BrowserMobileShellMode = "launcher" | "app" | "terminal" | "canvas";

export interface BrowserMobileShellState {
  surface: BrowserMobileShellSurface;
  mode: BrowserMobileShellMode;
  lastActiveAppSlug: string | null;
  lastActiveTerminalSessionId: string | null;
  canvasEnteredAt: string | null;
  updatedAt: string;
}

const MOBILE_SHELL_MODES = new Set<BrowserMobileShellMode>(["launcher", "app", "terminal", "canvas"]);
const SAFE_APP_SLUG = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;
const SAFE_TERMINAL_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function createDefaultBrowserMobileShellState(): BrowserMobileShellState {
  return {
    surface: "browser-shell",
    mode: "launcher",
    lastActiveAppSlug: null,
    lastActiveTerminalSessionId: null,
    canvasEnteredAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export function parseBrowserMobileShellState(value: unknown): BrowserMobileShellState {
  const fallback = createDefaultBrowserMobileShellState();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  const mode = typeof record.mode === "string" && MOBILE_SHELL_MODES.has(record.mode as BrowserMobileShellMode)
    ? record.mode as BrowserMobileShellMode
    : "launcher";

  return {
    surface: "browser-shell",
    mode,
    lastActiveAppSlug: safeAppSlug(record.lastActiveAppSlug),
    lastActiveTerminalSessionId: safeTerminalSessionId(record.lastActiveTerminalSessionId),
    canvasEnteredAt: safeIsoTimestamp(record.canvasEnteredAt),
    updatedAt: safeIsoTimestamp(record.updatedAt) ?? fallback.updatedAt,
  };
}

export function loadBrowserMobileShellState(storage: Storage | null = getBrowserStorage()): BrowserMobileShellState {
  if (!storage) return createDefaultBrowserMobileShellState();
  try {
    const raw = storage.getItem(BROWSER_MOBILE_SHELL_STATE_STORAGE_KEY);
    if (!raw) return createDefaultBrowserMobileShellState();
    return parseBrowserMobileShellState(JSON.parse(raw));
  } catch (err) {
    console.warn("[shell] failed to load mobile shell state", err);
    return createDefaultBrowserMobileShellState();
  }
}

export function saveBrowserMobileShellState(
  state: BrowserMobileShellState,
  storage: Storage | null = getBrowserStorage(),
): void {
  if (!storage) return;
  const safeState = parseBrowserMobileShellState(state);
  storage.setItem(BROWSER_MOBILE_SHELL_STATE_STORAGE_KEY, JSON.stringify(safeState));
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

function safeAppSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return SAFE_APP_SLUG.test(slug) ? slug : null;
}

function safeTerminalSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return SAFE_TERMINAL_SESSION_ID.test(sessionId) ? sessionId : null;
}

function safeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
