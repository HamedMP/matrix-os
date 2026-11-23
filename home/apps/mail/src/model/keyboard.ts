/**
 * The Mail keyboard map. `mailCommandForKey` turns a key press into a
 * command; `MailStore.runCommand` carries it out. Keys are ignored while the
 * owner types in a field, and with Ctrl, Cmd or Alt held, so browser and
 * shell shortcuts keep working.
 */

export type MailCommand =
  | "focusNext"
  | "focusPrevious"
  | "extendNext"
  | "extendPrevious"
  | "open"
  | "close"
  | "archive"
  | "trash"
  | "reply"
  | "replyAll"
  | "forward"
  | "compose"
  | "search"
  | "toggleSelect"
  | "toggleFlag"
  | "markRead"
  | "markUnread"
  | "undo"
  | "selectAll"
  | "clearSelection";

export interface MailKeyBinding {
  /** `KeyboardEvent.key`. Letters are matched case-sensitively, so "J" means Shift+J. */
  key: string;
  command: MailCommand;
  /** Owner-facing label for a shortcut sheet. */
  label: string;
}

export const MAIL_KEY_BINDINGS: readonly MailKeyBinding[] = Object.freeze([
  { key: "j", command: "focusNext", label: "Next conversation" },
  { key: "k", command: "focusPrevious", label: "Previous conversation" },
  { key: "ArrowDown", command: "focusNext", label: "Next conversation" },
  { key: "ArrowUp", command: "focusPrevious", label: "Previous conversation" },
  { key: "J", command: "extendNext", label: "Extend selection down" },
  { key: "K", command: "extendPrevious", label: "Extend selection up" },
  { key: "Enter", command: "open", label: "Open conversation" },
  { key: "o", command: "open", label: "Open conversation" },
  { key: "Escape", command: "close", label: "Back to the list" },
  { key: "u", command: "close", label: "Back to the list" },
  { key: "e", command: "archive", label: "Archive" },
  { key: "#", command: "trash", label: "Move to trash" },
  { key: "r", command: "reply", label: "Reply" },
  { key: "a", command: "replyAll", label: "Reply all" },
  { key: "f", command: "forward", label: "Forward" },
  { key: "c", command: "compose", label: "New message" },
  { key: "/", command: "search", label: "Search" },
  { key: "x", command: "toggleSelect", label: "Select conversation" },
  { key: "s", command: "toggleFlag", label: "Flag or unflag" },
  { key: "I", command: "markRead", label: "Mark as read" },
  { key: "U", command: "markUnread", label: "Mark as unread" },
  { key: "z", command: "undo", label: "Undo" },
  { key: "*", command: "selectAll", label: "Select all" },
]);

const BY_KEY: Readonly<Record<string, MailCommand>> = Object.freeze(
  Object.fromEntries(MAIL_KEY_BINDINGS.map((binding) => [binding.key, binding.command])),
);

/** The parts of a `KeyboardEvent` the map reads. */
export interface MailKeyInput {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** True when focus is in an input, textarea, select or contenteditable element. */
  editable?: boolean;
  /** True while an IME composition is in progress. */
  isComposing?: boolean;
}

/** True for an element that takes text input; pass `event.target`. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === "string" && ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName.toUpperCase());
}

export function mailCommandForKey(input: MailKeyInput): MailCommand | null {
  if (input.editable || input.isComposing || input.ctrlKey || input.metaKey || input.altKey) return null;
  if (input.shiftKey && input.key === "ArrowDown") return "extendNext";
  if (input.shiftKey && input.key === "ArrowUp") return "extendPrevious";
  return BY_KEY[input.key] ?? null;
}
