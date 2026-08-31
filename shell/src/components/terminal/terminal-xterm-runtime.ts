import type { IImageAddonOptions } from "@xterm/addon-image";
import type { Terminal } from "@xterm/xterm";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";

export const MAX_OSC52_BASE64_LENGTH = 1_000_000;
export const OSC52_ALLOWED_TARGETS = new Set([
  "",
  "c",
  "p",
  "s",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
]);
export const TERMINAL_SCROLLBACK_LINES = 10_000;
export const TERMINAL_SCROLL_SENSITIVITY = 1;
export const TERMINAL_FAST_SCROLL_SENSITIVITY = 5;
export const TERMINAL_MINIMUM_READABLE_FONT_SIZE = 10;
export const TERMINAL_CANONICAL_MAX_COLS = 500;
export const TERMINAL_CANONICAL_MAX_ROWS = 200;
export const IMAGE_ADDON_OPTIONS: IImageAddonOptions = {
  enableSizeReports: false,
  pixelLimit: 4_194_304,
  storageLimit: 32,
  showPlaceholder: true,
  sixelSupport: true,
  sixelScrolling: true,
  sixelPaletteLimit: 256,
  sixelSizeLimit: 8_000_000,
  iipSupport: true,
  iipSizeLimit: 8_000_000,
};

export type DisposableWebglAddon = { dispose: () => void };
export type CanonicalReplayRequest = {
  mode: "cold-replay" | "cursor-resume";
  requestedSeq: number;
};

export function isAppleCommandPlatform(platform: string): boolean {
  return /^(Mac|iPad|iPhone|iPod)/.test(platform);
}

export function shouldDisableWebglRenderer(suppressNativeKeyboard: boolean): boolean {
  if (suppressNativeKeyboard) return true;
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  const isAppleMobile = /\b(iPad|iPhone|iPod)\b/.test(userAgent)
    || (userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const isSafari = /Safari\//.test(userAgent) && !/(Chrome|CriOS|FxiOS|EdgiOS)\//.test(userAgent);
  return isAppleMobile && isSafari;
}

export function scrollTerminalViewportToBottom(term: Terminal | null): void {
  term?.scrollToBottom();
}

export function terminalDebug(event: string, details: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  console.info("[terminal-debug][pane]", event, details);
}

export function suppressXtermNativeKeyboard(container: HTMLElement): void {
  const helper = container.querySelector("textarea.xterm-helper-textarea");
  if (!(helper instanceof HTMLTextAreaElement)) {
    return;
  }
  helper.inputMode = "none";
  helper.readOnly = true;
  helper.autocomplete = "off";
  helper.autocapitalize = "none";
  helper.spellcheck = false;
  helper.setAttribute("aria-hidden", "true");
}

export function applyXtermSurfaceBackground(
  xtermElement: HTMLElement | null | undefined,
  background: string,
): void {
  if (!xtermElement) {
    return;
  }

  xtermElement.style.backgroundColor = background;
  for (const selector of [".xterm-viewport", ".xterm-scrollable-element"]) {
    const surface = xtermElement.querySelector(selector);
    if (surface instanceof HTMLElement) {
      surface.style.backgroundColor = background;
    }
  }
}

export function applyXtermScrollSurface(
  xtermElement: HTMLElement | null | undefined,
  background: string,
): void {
  if (!xtermElement) {
    return;
  }

  applyXtermSurfaceBackground(xtermElement, background);
  xtermElement.classList.add("matrix-terminal-xterm-root");
  xtermElement.style.width = "100%";
  xtermElement.style.height = "100%";
  xtermElement.style.overscrollBehavior = "contain";
  xtermElement.style.touchAction = "pan-y";

  const viewport = xtermElement.querySelector(".xterm-viewport");
  if (!(viewport instanceof HTMLElement)) {
    return;
  }

  viewport.classList.add("matrix-terminal-xterm-viewport");
  viewport.style.height = "100%";
  viewport.style.overflowY = "scroll";
  viewport.style.setProperty("scrollbar-gutter", "stable");
  viewport.style.overscrollBehavior = "contain";
  viewport.style.touchAction = "pan-y";
}

export function applyXtermScrollOptions(term: Terminal): void {
  term.options.scrollback = TERMINAL_SCROLLBACK_LINES;
  term.options.scrollSensitivity = TERMINAL_SCROLL_SENSITIVITY;
  term.options.fastScrollSensitivity = TERMINAL_FAST_SCROLL_SENSITIVITY;
  term.options.scrollOnUserInput = true;
}

export function refreshTerminalRenderer(term: Terminal): void {
  if (term.rows <= 0) {
    return;
  }
  term.refresh(0, term.rows - 1);
}

export function toDisposableWebglAddon(addon: unknown): DisposableWebglAddon | null {
  if (!addon || typeof addon !== "object") {
    return null;
  }
  const dispose = (addon as { dispose?: unknown }).dispose;
  return typeof dispose === "function" ? (addon as DisposableWebglAddon) : null;
}

export function terminalTelemetry(
  event: string,
  properties: Record<string, string | number | boolean | undefined>,
): void {
  const payload = {
    source: "terminal-pane",
    event,
    ...properties,
  };
  capturePostHogEvent("shell_terminal_ws", payload);
  capturePostHogLog(event.includes("error") ? "error" : "info", `terminal websocket ${event}`, payload);
}

export function describeReadyState(ws: WebSocket | null): string {
  if (!ws) {
    return "null";
  }

  switch (ws.readyState) {
    case WebSocket.CONNECTING:
      return "CONNECTING";
    case WebSocket.OPEN:
      return "OPEN";
    case WebSocket.CLOSING:
      return "CLOSING";
    case WebSocket.CLOSED:
      return "CLOSED";
    default:
      return `UNKNOWN(${String((ws as { readyState?: unknown }).readyState)})`;
  }
}
