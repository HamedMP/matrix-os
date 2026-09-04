export type TerminalClipboardAction = "copy" | "paste" | "select-all";

export type TerminalClipboardResult =
  | "success"
  | "empty"
  | "unavailable"
  | "stale-target"
  | "failed";

export interface TerminalClipboardShortcutInput {
  type: "keydown" | "keyup" | "keypress";
  key: string;
  isMac: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  hasSelection: boolean;
}

export type TerminalPointerEventType =
  | "mousedown"
  | "mouseup"
  | "mousemove"
  | "contextmenu";

export interface TerminalPointerInput {
  type: TerminalPointerEventType;
  button: number;
  buttons: number;
  hasSelection: boolean;
}

export type TerminalPointerDecision =
  | "forward"
  | "shield-selection"
  | "open-context-menu";

export function classifyTerminalClipboardShortcut(
  input: TerminalClipboardShortcutInput,
): TerminalClipboardAction | null {
  if (input.type !== "keydown" || input.repeat || input.isComposing) {
    return null;
  }

  const key = input.key.toLowerCase();
  const isMacCommand = input.isMac
    && input.metaKey
    && !input.ctrlKey
    && !input.altKey;
  const isTerminalControl = !input.metaKey
    && input.ctrlKey
    && input.shiftKey
    && !input.altKey;

  if (key === "c" && input.hasSelection) {
    if (isMacCommand || isTerminalControl) return "copy";
    return null;
  }

  if (key === "v") {
    if ((isMacCommand && !input.shiftKey) || isTerminalControl) return "paste";
    return null;
  }

  if (key === "a" && isMacCommand && !input.shiftKey) {
    return "select-all";
  }

  return null;
}

export function classifyTerminalPointerEvent(
  input: TerminalPointerInput,
): TerminalPointerDecision {
  if (!input.hasSelection) return "forward";
  if (input.type === "contextmenu") return "open-context-menu";

  const hasSecondaryButton = input.button === 2 || (input.buttons & 2) === 2;
  if (input.type === "mousemove") {
    return input.buttons === 0 || hasSecondaryButton
      ? "shield-selection"
      : "forward";
  }
  if ((input.type === "mousedown" || input.type === "mouseup") && input.button === 2) {
    return "shield-selection";
  }
  return "forward";
}
