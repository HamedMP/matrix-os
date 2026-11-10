// The Electron Desktop Terminal window (specs/651-desktop-terminal-window).
// It shares the trusted renderer bundle and preload with the main window but
// gets a deliberately small IPC surface, enforced in the preload and again by
// the main-process sender policy.
import { z } from "zod/v4";
import type { EventChannel, InvokeChannel } from "./ipc-contract";

export const TERMINAL_WINDOW_ARG = "--matrix-terminal-window";
export const TERMINAL_WINDOW_QUERY_KEY = "window";
export const TERMINAL_WINDOW_QUERY_VALUE = "terminal";
// A dedicated session: the default session's bearer injection never applies
// here, so the window holds no gateway credential until it is given one.
export const TERMINAL_WINDOW_PARTITION = "persist:terminal-window";

const Empty = z.object({}).strict();
const Ok = z.object({ ok: z.boolean() }).strict();

export const TERMINAL_WINDOW_INVOKE = {
  "terminal-window:open": { request: Empty, response: Ok },
  "terminal-window:focus-main": { request: Empty, response: Ok },
} as const;

/** Channels only the Terminal window may call. */
export const TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS = ["terminal-window:focus-main"] as const satisfies readonly InvokeChannel[];

/** Everything the Terminal window may call. */
export const TERMINAL_WINDOW_INVOKE_CHANNELS = [
  "auth:status",
  "runtime:list-computers",
  "app:get-version",
  "app:get-zoom",
  "app:set-zoom",
  // Only for the keys in TERMINAL_WINDOW_STATE_KEYS; see windowMayInvoke.
  "state:get",
  "terminal:read-clipboard-files",
  ...TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS,
] as const satisfies readonly InvokeChannel[];

/** Events the Terminal window may subscribe to. */
export const TERMINAL_WINDOW_EVENT_CHANNELS = ["auth:changed", "window:focus-changed"] as const satisfies readonly EventChannel[];

export type WindowRole = "main" | "terminal";

/**
 * The saved state the Terminal window may read: the owner's theme and fonts,
 * so it looks like the rest of the app. Everything else in the local store
 * (recents, layouts, project views) stays with the main window.
 */
export const TERMINAL_WINDOW_STATE_KEYS: readonly string[] = ["appearance"];

const terminalInvoke = new Set<string>(TERMINAL_WINDOW_INVOKE_CHANNELS);
const terminalOnlyInvoke = new Set<string>(TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS);
const terminalEvents = new Set<string>(TERMINAL_WINDOW_EVENT_CHANNELS);

/**
 * The one rule for which window may invoke which channel, and with what; the
 * preload and the main process both apply it to the raw request.
 */
export function windowMayInvoke(role: WindowRole, channel: string, payload?: unknown): boolean {
  if (role === "main") return !terminalOnlyInvoke.has(channel);
  if (!terminalInvoke.has(channel)) return false;
  if (channel !== "state:get") return true;
  const key = (payload as { key?: unknown } | null | undefined)?.key;
  return typeof key === "string" && TERMINAL_WINDOW_STATE_KEYS.includes(key);
}

export function windowMayListen(role: WindowRole, channel: string): boolean {
  return role === "main" || terminalEvents.has(channel);
}

export function isTerminalWindowLocation(search: string): boolean {
  return new URLSearchParams(search).get(TERMINAL_WINDOW_QUERY_KEY) === TERMINAL_WINDOW_QUERY_VALUE;
}

export function terminalWindowUrl(rendererUrl: string): string {
  const url = new URL(rendererUrl);
  url.searchParams.set(TERMINAL_WINDOW_QUERY_KEY, TERMINAL_WINDOW_QUERY_VALUE);
  return url.toString();
}
