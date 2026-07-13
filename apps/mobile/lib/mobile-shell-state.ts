import AsyncStorage from "@react-native-async-storage/async-storage";
import { isSafeShellSessionName } from "@/lib/terminal-state";

export const MOBILE_SHELL_STATE_STORAGE_KEY = "matrix.mobileShellState.v1";

export type MobileShellSurface = "browser-shell" | "native-mobile";
export type MobileShellMode = "launcher" | "app" | "terminal" | "canvas";

export interface MobileShellState {
  surface: MobileShellSurface;
  mode: MobileShellMode;
  lastActiveAppSlug: string | null;
  lastActiveTerminalSessionId: string | null;
  terminalHandoffSessionId?: string | null;
  canvasEnteredAt: string | null;
  updatedAt: string;
}

type MobileShellStorage = Pick<typeof AsyncStorage, "getItem" | "setItem">;

const MOBILE_SHELL_MODES = new Set<MobileShellMode>(["launcher", "app", "terminal", "canvas"]);
const SAFE_APP_SLUG = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

function createDefaultMobileShellState(surface: MobileShellSurface = "native-mobile"): MobileShellState {
  return {
    surface,
    mode: "launcher",
    lastActiveAppSlug: null,
    lastActiveTerminalSessionId: null,
    terminalHandoffSessionId: null,
    canvasEnteredAt: null,
    updatedAt: new Date().toISOString(),
  };
}

export function parseMobileShellState(
  value: unknown,
  surface: MobileShellSurface = "native-mobile",
): MobileShellState {
  const fallback = createDefaultMobileShellState(surface);
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const record = value as Record<string, unknown>;
  const mode = typeof record.mode === "string" && MOBILE_SHELL_MODES.has(record.mode as MobileShellMode)
    ? record.mode as MobileShellMode
    : "launcher";

  return {
    surface,
    mode,
    lastActiveAppSlug: safeAppSlug(record.lastActiveAppSlug),
    lastActiveTerminalSessionId: safeTerminalSessionId(record.lastActiveTerminalSessionId),
    terminalHandoffSessionId: safeTerminalSessionId(record.terminalHandoffSessionId),
    canvasEnteredAt: safeIsoTimestamp(record.canvasEnteredAt),
    updatedAt: safeIsoTimestamp(record.updatedAt) ?? fallback.updatedAt,
  };
}

export async function loadMobileShellState(storage: MobileShellStorage = AsyncStorage): Promise<MobileShellState> {
  try {
    const raw = await storage.getItem(MOBILE_SHELL_STATE_STORAGE_KEY);
    if (!raw) return createDefaultMobileShellState();
    return parseMobileShellState(JSON.parse(raw));
  } catch (err) {
    console.warn("[mobile] failed to load mobile shell state", err);
    return createDefaultMobileShellState();
  }
}

export async function saveMobileShellState(
  state: MobileShellState,
  storage: MobileShellStorage = AsyncStorage,
): Promise<void> {
  const safeState = parseMobileShellState(state);
  await storage.setItem(MOBILE_SHELL_STATE_STORAGE_KEY, JSON.stringify(safeState));
}

function safeAppSlug(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return SAFE_APP_SLUG.test(slug) ? slug : null;
}

function safeTerminalSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const sessionId = value.trim();
  return isSafeShellSessionName(sessionId) ? sessionId : null;
}

function safeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}
