// The Electron Desktop Terminal window (specs/651-desktop-terminal-window).
// It shares the trusted renderer bundle and preload with the main window but
// gets a deliberately small IPC surface, enforced in the preload and again by
// the main-process sender policy.
import { z } from "zod/v4";
import type { EventChannel, InvokeChannel } from "./ipc-contract";
import { LOCAL_TERMINAL_EVENT_CHANNELS, LOCAL_TERMINAL_INVOKE_CHANNELS } from "./local-terminals";
import { DESKTOP_LINK_EVENT_CHANNELS, DESKTOP_LINK_INVOKE_CHANNELS } from "./desktop-link";

export const TERMINAL_WINDOW_ARG = "--matrix-terminal-window";
export const TERMINAL_WINDOW_QUERY_KEY = "window";
export const TERMINAL_WINDOW_QUERY_VALUE = "terminal";
// A dedicated session: the default session's bearer injection never applies
// here, so the window holds no gateway credential until it is given one.
export const TERMINAL_WINDOW_PARTITION = "persist:terminal-window";

/** A computer in the owner's inventory, as the platform names it. */
export const RUNTIME_SLOT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** The platform lists at most this many computers per owner. */
export const TERMINAL_WINDOW_MAX_COMPUTERS = 20;

const Empty = z.object({}).strict();
const Ok = z.object({ ok: z.boolean() }).strict();

/**
 * Herdr's Terminal window shortcuts (spec 2706), delivered from menu
 * accelerators that exist only while the Terminal window has focus.
 */
export const TERMINAL_WINDOW_COMMANDS = [
  "new-terminal", "close-terminal", "select", "next", "previous", "rename", "toggle-sidebar", "picker", "find",
  "split-right", "split-down", "close-pane", "zoom-pane", "focus-pane", "swap-pane",
  "next-tab", "previous-tab", "space",
] as const;
export type TerminalWindowCommandName = (typeof TERMINAL_WINDOW_COMMANDS)[number];
const PaneDirectionSchema = z.enum(["left", "right", "up", "down"]);
export const TerminalWindowCommandSchema = z.discriminatedUnion("command", [
  z.strictObject({ command: z.literal("select"), index: z.number().int().min(1).max(9) }),
  // Ctrl+1…9 switches to that space in the sidebar's order; Ctrl+0 is All.
  z.strictObject({ command: z.literal("space"), index: z.number().int().min(0).max(9) }),
  z.strictObject({ command: z.enum(["focus-pane", "swap-pane"]), direction: PaneDirectionSchema }),
  z.strictObject({ command: z.enum(TERMINAL_WINDOW_COMMANDS).exclude(["select", "space", "focus-pane", "swap-pane"]) }),
]);
export type TerminalWindowCommand = z.infer<typeof TerminalWindowCommandSchema>;

export interface ShortcutKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const PRIMARY_KEYS = new Set(["n", "t", "w", "f", "p", "d", "b", "[", "]", "enter", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
const ARROWS = new Set(["arrowleft", "arrowright", "arrowup", "arrowdown"]);

/**
 * The keys the Terminal window's menu owns (terminal-menu-items.ts). A focused
 * terminal leaves these to the menu instead of sending them to its program or
 * its own pane bindings, so every shortcut works while a terminal has focus.
 * Cmd (Super off macOS) is the menu's modifier; Ctrl stays with the shell
 * except for Ctrl+Tab and Ctrl+0…9 (spaces). Cmd+C/V/A stay with the terminal's clipboard.
 */
export function isTerminalWindowShortcut(event: ShortcutKeyEvent): boolean {
  const key = event.key.toLowerCase();
  if (key === "f2" && !event.metaKey && !event.ctrlKey && !event.altKey) return true;
  if (key === "tab" && event.ctrlKey && !event.metaKey && !event.altKey) return true;
  // Ctrl+0…9 switch space.
  if (/^[0-9]$/.test(key) && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) return true;
  if (!event.metaKey || event.ctrlKey) return false;
  if (event.altKey) return ARROWS.has(key) || (key === "w" && !event.shiftKey);
  return PRIMARY_KEYS.has(key);
}

export const TERMINAL_WINDOW_EVENTS = {
  "terminal-window:command": TerminalWindowCommandSchema,
} as const;

export const TERMINAL_WINDOW_INVOKE = {
  "terminal-window:open": { request: Empty, response: Ok },
  // `to: "settings"` also opens Settings there (the sidebar's Settings button).
  "terminal-window:focus-main": { request: z.strictObject({ to: z.literal("settings").optional() }), response: Ok },
} as const;

/** Channels only the Terminal window may call. */
export const TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS = [
  "terminal-window:focus-main", ...LOCAL_TERMINAL_INVOKE_CHANNELS, ...DESKTOP_LINK_INVOKE_CHANNELS,
] as const satisfies readonly InvokeChannel[];

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
  // So its Terminal keeps the keys its profile binds (specs/653).
  "shortcuts:set-terminal-claims",
  ...TERMINAL_WINDOW_ONLY_INVOKE_CHANNELS,
] as const satisfies readonly InvokeChannel[];

/** Events the Terminal window may subscribe to. */
export const TERMINAL_WINDOW_EVENT_CHANNELS = [
  "auth:changed", "window:focus-changed", "shortcuts:changed", "terminal-window:command", ...LOCAL_TERMINAL_EVENT_CHANNELS, ...DESKTOP_LINK_EVENT_CHANNELS,
] as const satisfies readonly EventChannel[];

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
