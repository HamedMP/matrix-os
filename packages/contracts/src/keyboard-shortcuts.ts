import { z } from "zod/v4";

// Pure registry shared by the Electron main process and the renderers.
// No DOM, React or Node imports.

export type ShortcutPlatform = "mac" | "other";
export type ShortcutGroup = "apps" | "navigation" | "tabs" | "chat" | "terminal";

export const SHORTCUT_ACTION_IDS = [
  "app.next", "app.previous", "app.launcher", "app.close", "app.minimize", "app.reopen",
  "app.switch-1", "app.switch-2", "app.switch-3", "app.switch-4", "app.switch-5",
  "app.switch-6", "app.switch-7", "app.switch-8", "app.switch-9",
  "app.show-desktop", "app.toggle-full-size", "app.open-files",
  "app.tile-left", "app.tile-right", "app.tile-top", "app.tile-bottom", "app.restore-size",
  "nav.palette", "nav.quick-open", "nav.settings",
  "tabs.new-context", "tabs.new", "tabs.close",
  "chat.new-thread", "chat.open",
  "terminal.focus", "terminal.window",
] as const;

export type ShortcutActionId = (typeof SHORTCUT_ACTION_IDS)[number];

export interface ShortcutActionDefinition {
  id: ShortcutActionId;
  label: string;
  description: string;
  group: ShortcutGroup;
  defaults: Record<ShortcutPlatform, readonly string[]>;
}

export const MAX_BINDINGS_PER_ACTION = 4;
const MAX_BINDING_LENGTH = 40;

function action(
  id: ShortcutActionId,
  group: ShortcutGroup,
  label: string,
  description: string,
  mac: readonly string[],
  other: readonly string[],
): ShortcutActionDefinition {
  return { id, group, label, description, defaults: { mac, other } };
}

// Same keys on every platform, as in Rectangle.
// Window arrangement: Ctrl+Shift on macOS, because Rectangle and Magnet take
// Ctrl+Option there. Elsewhere Ctrl+Shift+arrow selects text by word, so the
// keys stay on Ctrl+Alt.
function arrange(key: string): [readonly string[], readonly string[]] {
  return [[`Ctrl+Shift+${key}`], [`Ctrl+Alt+${key}`]];
}

// "Mod" binding: Cmd on mac, Ctrl elsewhere.
function mod(rest: string): [readonly string[], readonly string[]] {
  return [[`Cmd+${rest}`], [`Ctrl+${rest}`]];
}

const SWITCH_ACTIONS = ([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) =>
  action(`app.switch-${n}`, "apps", `Switch to app ${n}`, `Go to app ${n} in the taskbar.`, ...mod(String(n))),
);

export const SHORTCUT_ACTIONS: readonly ShortcutActionDefinition[] = [
  action("app.next", "apps", "Next app", "Move to the next open app.", ["Ctrl+Tab"], ["Ctrl+Tab"]),
  action("app.previous", "apps", "Previous app", "Move to the previous open app.", ["Ctrl+Shift+Tab"], ["Ctrl+Shift+Tab"]),
  action("app.launcher", "apps", "Open App Launcher", "Show or hide the App Launcher.", ["Alt+Space"], ["Ctrl+Space"]),
  action("app.close", "apps", "Close app", "Close the selected app.", ...mod("Q")),
  action("app.minimize", "apps", "Minimize app", "Minimize the selected app.", ...mod("M")),
  action("app.reopen", "apps", "Reopen closed app", "Reopen the app you closed most recently.", ...mod("Shift+T")),
  ...SWITCH_ACTIONS,
  action("app.show-desktop", "apps", "Show desktop", "Minimize every open app.", [], []),
  action("app.toggle-full-size", "apps", "Toggle app full size", "Make the selected app fill the screen, or restore it.", ...arrange("Enter")),
  action("app.open-files", "apps", "Open Files", "Open the Files app.", [], []),
  action("app.tile-left", "apps", "Move app to left half", "Place the selected app on the left half of the desktop.", ...arrange("Left")),
  action("app.tile-right", "apps", "Move app to right half", "Place the selected app on the right half of the desktop.", ...arrange("Right")),
  action("app.tile-top", "apps", "Move app to top half", "Place the selected app on the top half of the desktop.", ...arrange("Up")),
  action("app.tile-bottom", "apps", "Move app to bottom half", "Place the selected app on the bottom half of the desktop.", ...arrange("Down")),
  action("app.restore-size", "apps", "Restore app size", "Return the selected app to its size before it was moved to a half or made full size.", ...arrange("Backspace")),
  action("nav.palette", "navigation", "Command palette", "Search commands and apps.", ...mod("K")),
  action("nav.quick-open", "navigation", "Go to file", "Find and open a file by name.", ...mod("P")),
  action("nav.settings", "navigation", "Settings", "Open Settings.", ...mod(",")),
  action("tabs.new-context", "tabs", "New", "Create something new in the current app.", ...mod("N")),
  action("tabs.new", "tabs", "New tab", "Open a new tab in the current app.", ...mod("T")),
  action("tabs.close", "tabs", "Close tab", "Close the current tab.", ...mod("W")),
  action("chat.new-thread", "chat", "New agent thread", "Start a new thread with an agent.", ...mod("J")),
  action("chat.open", "chat", "Open Chat", "Open or focus the chat with Matrix.", ...mod("Shift+O")),
  action("terminal.focus", "terminal", "Terminal", "Open or focus the Terminal.", ["Cmd+Alt+T"], ["Ctrl+Alt+T"]),
  action("terminal.window", "terminal", "Terminal window", "Open the Terminal in its own window.", ["Cmd+Alt+Shift+T"], ["Ctrl+Alt+Shift+T"]),
];

const ACTION_ID_SET: ReadonlySet<string> = new Set(SHORTCUT_ACTION_IDS);

function isActionId(id: string): id is ShortcutActionId {
  return ACTION_ID_SET.has(id);
}

export const ShortcutOverridesSchema = z.strictObject({
  version: z.literal(1),
  overrides: z
    .record(z.string().max(64), z.array(z.string().max(MAX_BINDING_LENGTH)).max(MAX_BINDINGS_PER_ACTION * 4))
    .refine((value) => Object.keys(value).length <= SHORTCUT_ACTION_IDS.length * 2),
});

export type ShortcutOverrides = z.infer<typeof ShortcutOverridesSchema>;

export const EMPTY_SHORTCUT_OVERRIDES: ShortcutOverrides = Object.freeze({
  version: 1,
  overrides: Object.freeze({}) as Record<string, string[]>,
}) as ShortcutOverrides;

export type EffectiveShortcuts = Record<ShortcutActionId, string[]>;

// ---------------------------------------------------------------------------
// Binding grammar

const MODIFIERS = ["Cmd", "Ctrl", "Alt", "Shift"] as const;
type Modifier = (typeof MODIFIERS)[number];

const PUNCTUATION_KEYS = [",", ".", "/", ";", "'", "[", "]", "\\", "-", "=", "`"];
const NAMED_KEYS = [
  "Tab", "Space", "Enter", "Up", "Down", "Left", "Right",
  "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
];
const FUNCTION_KEYS = Array.from({ length: 24 }, (_, i) => `F${i + 1}`);
const LETTER_KEYS = Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i));
const DIGIT_KEYS = Array.from({ length: 10 }, (_, i) => String(i));

const VALID_KEYS: ReadonlySet<string> = new Set([
  ...LETTER_KEYS, ...DIGIT_KEYS, ...FUNCTION_KEYS, ...NAMED_KEYS, ...PUNCTUATION_KEYS,
]);
const FUNCTION_KEY_SET: ReadonlySet<string> = new Set(FUNCTION_KEYS);

interface ParsedBinding {
  modifiers: Modifier[];
  key: string;
}

function parseBinding(binding: string, platform: ShortcutPlatform): ParsedBinding | null {
  if (binding.length === 0 || binding.length > MAX_BINDING_LENGTH) return null;
  const parts = binding.split("+");
  const key = parts.pop();
  if (key === undefined || !VALID_KEYS.has(key)) return null;
  const modifiers: Modifier[] = [];
  let lastIndex = -1;
  for (const part of parts) {
    const index = MODIFIERS.indexOf(part as Modifier);
    if (index <= lastIndex) return null; // unknown, duplicate or out of order
    if (part === "Cmd" && platform !== "mac") return null;
    modifiers.push(part as Modifier);
    lastIndex = index;
  }
  return { modifiers, key };
}

// ---------------------------------------------------------------------------
// Key events

export interface KeyEventLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EVENT_KEY_NAMES: Readonly<Record<string, string>> = {
  " ": "Space",
  Tab: "Tab",
  Enter: "Enter",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

const CODE_KEYS: Readonly<Record<string, string>> = {
  Comma: ",", Period: ".", Slash: "/", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Backslash: "\\", Minus: "-", Equal: "=", Backquote: "`",
  Space: "Space", NumpadEnter: "Enter", ...EVENT_KEY_NAMES,
};

function keyFromEventKey(key: string): string | null {
  const named = EVENT_KEY_NAMES[key];
  if (named !== undefined) return named;
  if (FUNCTION_KEY_SET.has(key)) return key;
  if (key.length === 1 && key >= "!" && key <= "~") {
    const upper = key.toUpperCase();
    return VALID_KEYS.has(upper) ? upper : null;
  }
  return null;
}

function keyFromEventCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1] ?? null;
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1] ?? null;
  if (FUNCTION_KEY_SET.has(code)) return code;
  return CODE_KEYS[code] ?? null;
}

export function heldModifiers(e: KeyEventLike, platform: ShortcutPlatform): string[] {
  const held: string[] = [];
  if (e.metaKey && platform === "mac") held.push("Cmd");
  if (e.ctrlKey) held.push("Ctrl");
  if (e.altKey) held.push("Alt");
  if (e.shiftKey) held.push("Shift");
  return held;
}

/**
 * The binding for the character the key types, without the digit-row rule in
 * bindingFromKeyEvent. The main-process matcher uses it to leave a native menu
 * key alone: on AZERTY the 6 key types "-", and Cmd+- must still zoom out.
 */
export function characterBindingFromKeyEvent(e: KeyEventLike, platform: ShortcutPlatform): string | null {
  if (e.key === "Escape") return null;
  const key = keyFromEventKey(e.key) ?? keyFromEventCode(e.code);
  if (key === null) return null;
  return [...heldModifiers(e, platform), key].join("+");
}

export function bindingFromKeyEvent(e: KeyEventLike, platform: ShortcutPlatform): string | null {
  if (e.key === "Escape") return null;
  // The digit row types punctuation on some layouts (AZERTY: Digit4 is "'"),
  // so a digit key binds as its digit. Letters keep "character wins".
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1];
  const key = digit ?? keyFromEventKey(e.key) ?? keyFromEventCode(e.code);
  if (key === null) return null;
  return [...heldModifiers(e, platform), key].join("+");
}

// ---------------------------------------------------------------------------
// Validation

export type BindingRejection =
  | { reason: "invalid" }
  | { reason: "needs-modifier" }
  | { reason: "reserved-system" }
  | { reason: "reserved-menu"; role: string };

const RESERVED_SYSTEM: Record<ShortcutPlatform, ReadonlySet<string>> = {
  mac: new Set(["Cmd+Tab", "Cmd+Shift+Tab", "Cmd+Space", "Cmd+`"]),
  other: new Set(["Alt+Tab", "Alt+Shift+Tab", "Alt+F4", "Alt+Space"]),
};

function reservedMenu(platform: ShortcutPlatform): ReadonlyMap<string, string> {
  const m = platform === "mac" ? "Cmd" : "Ctrl";
  const entries: [string, string][] = [
    [`${m}+Z`, "Undo"], [`${m}+Shift+Z`, "Redo"], [`${m}+X`, "Cut"], [`${m}+C`, "Copy"],
    [`${m}+V`, "Paste"], [`${m}+A`, "Select All"], [`${m}+R`, "Reload"],
    [`${m}+=`, "Zoom In"], [`${m}+-`, "Zoom Out"], [`${m}+0`, "Actual Size"],
  ];
  for (let n = 1; n <= 7; n++) entries.push([`${m}+Alt+${n}`, "Task panels"]);
  if (platform === "mac") {
    entries.push(
      ["Cmd+H", "Hide"], ["Cmd+Alt+H", "Hide Others"], ["Cmd+Ctrl+F", "Full Screen"],
      ["Cmd+Alt+I", "Developer Tools"], ["Cmd+Alt+Shift+V", "Paste and Match Style"],
    );
  } else {
    entries.push(["F11", "Full Screen"], ["Ctrl+Shift+I", "Developer Tools"]);
  }
  return new Map(entries);
}

const RESERVED_MENU: Record<ShortcutPlatform, ReadonlyMap<string, string>> = {
  mac: reservedMenu("mac"),
  other: reservedMenu("other"),
};

export function validateBinding(
  binding: string,
  platform: ShortcutPlatform,
): { ok: true } | ({ ok: false } & BindingRejection) {
  const parsed = parseBinding(binding, platform);
  if (parsed === null) return { ok: false, reason: "invalid" };
  const hasCommandModifier = parsed.modifiers.some((modifier) => modifier !== "Shift");
  if (!hasCommandModifier && !FUNCTION_KEY_SET.has(parsed.key)) return { ok: false, reason: "needs-modifier" };
  if (RESERVED_SYSTEM[platform].has(binding)) return { ok: false, reason: "reserved-system" };
  const role = RESERVED_MENU[platform].get(binding);
  if (role !== undefined) return { ok: false, reason: "reserved-menu", role };
  return { ok: true };
}

function isValidBinding(binding: string, platform: ShortcutPlatform): boolean {
  return validateBinding(binding, platform).ok;
}

// ---------------------------------------------------------------------------
// Resolution

function storedOverrides(overrides: ShortcutOverrides | null): Record<string, string[]> {
  if (overrides === null) return {};
  const parsed = ShortcutOverridesSchema.safeParse(overrides);
  return parsed.success ? parsed.data.overrides : {};
}

/**
 * Defaults plus overrides. An override wins a binding over another action's
 * default; invalid stored bindings and unknown ids are dropped.
 */
export function resolveShortcuts(overrides: ShortcutOverrides | null, platform: ShortcutPlatform): EffectiveShortcuts {
  const stored = storedOverrides(overrides);
  const effective = {} as EffectiveShortcuts;
  const claimed = new Set<string>();
  for (const { id } of SHORTCUT_ACTIONS) {
    const list = Object.hasOwn(stored, id) ? stored[id] : undefined;
    if (list === undefined) continue;
    effective[id] = [];
    for (const binding of list) {
      if (effective[id].length >= MAX_BINDINGS_PER_ACTION) break;
      if (claimed.has(binding) || !isValidBinding(binding, platform)) continue;
      claimed.add(binding);
      effective[id].push(binding);
    }
  }
  for (const { id, defaults } of SHORTCUT_ACTIONS) {
    if (effective[id] !== undefined) continue;
    effective[id] = defaults[platform].filter((binding) => !claimed.has(binding));
  }
  return effective;
}

export function findConflict(
  effective: EffectiveShortcuts,
  binding: string,
  except: ShortcutActionId,
): ShortcutActionId | null {
  for (const id of SHORTCUT_ACTION_IDS) {
    if (id !== except && effective[id]?.includes(binding)) return id;
  }
  return null;
}

export function validateOverrides(overrides: ShortcutOverrides, platform: ShortcutPlatform): boolean {
  const parsed = ShortcutOverridesSchema.safeParse(overrides);
  if (!parsed.success) return false;
  const seen = new Set<string>();
  for (const [id, list] of Object.entries(parsed.data.overrides)) {
    if (!isActionId(id) || list.length > MAX_BINDINGS_PER_ACTION) return false;
    for (const binding of list) {
      if (seen.has(binding) || !isValidBinding(binding, platform)) return false;
      seen.add(binding);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Editing helpers (immutable)

function withOverride(overrides: ShortcutOverrides, changes: Partial<Record<ShortcutActionId, string[]>>): ShortcutOverrides {
  return { version: 1, overrides: { ...overrides.overrides, ...changes } };
}

/** Adds a binding to an action, moving it off any other action that holds it. */
export function addBinding(
  overrides: ShortcutOverrides,
  id: ShortcutActionId,
  binding: string,
  platform: ShortcutPlatform,
): ShortcutOverrides {
  if (!isValidBinding(binding, platform)) return overrides;
  const effective = resolveShortcuts(overrides, platform);
  const current = effective[id];
  if (current.includes(binding) || current.length >= MAX_BINDINGS_PER_ACTION) return overrides;
  const changes: Partial<Record<ShortcutActionId, string[]>> = { [id]: [...current, binding] };
  const owner = findConflict(effective, binding, id);
  if (owner !== null) changes[owner] = effective[owner].filter((held) => held !== binding);
  return withOverride(overrides, changes);
}

export function removeBinding(
  overrides: ShortcutOverrides,
  id: ShortcutActionId,
  binding: string,
  platform: ShortcutPlatform,
): ShortcutOverrides {
  const current = resolveShortcuts(overrides, platform)[id];
  if (!current.includes(binding)) return overrides;
  return withOverride(overrides, { [id]: current.filter((held) => held !== binding) });
}

export function resetAction(overrides: ShortcutOverrides, id: ShortcutActionId): ShortcutOverrides {
  const { [id]: _removed, ...rest } = overrides.overrides;
  return { version: 1, overrides: rest };
}

export function isOverridden(overrides: ShortcutOverrides, id: ShortcutActionId): boolean {
  return Object.hasOwn(overrides.overrides, id);
}

// ---------------------------------------------------------------------------
// Display

const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Cmd: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧",
  Tab: "⇥", Enter: "↩", Backspace: "⌫", Delete: "⌦",
  Up: "↑", Down: "↓", Left: "←", Right: "→",
};

/** Chip parts for a binding: symbols on mac, words elsewhere. */
export function formatBinding(binding: string, platform: ShortcutPlatform): string[] {
  const parts = binding.split("+");
  // A trailing empty part never occurs for valid bindings ("+" is not a key).
  return platform === "mac" ? parts.map((part) => MAC_SYMBOLS[part] ?? part) : parts;
}
