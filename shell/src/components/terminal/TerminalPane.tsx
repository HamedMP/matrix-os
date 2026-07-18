"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getGatewayUrl, getGatewayWs } from "@/lib/gateway";
import { capturePostHogEvent, capturePostHogLog } from "@/lib/posthog-client";
import { createSocketHealth } from "@/lib/socket-health";
import { isTerminalDebugEnabled } from "@/lib/terminal-debug";
import { useTerminalSettings } from "@/stores/terminal-settings";
import { buildAuthenticatedWebSocketUrl, getWebSocketAuthToken } from "@/lib/websocket-auth";
import type { Theme } from "@/hooks/useTheme";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { ImageAddon, type IImageAddonOptions } from "@xterm/addon-image";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import type { TerminalFontFamily, TerminalThemeId } from "@/stores/terminal-settings";
import { buildXtermTheme } from "./terminal-themes";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { WebLinkProvider } from "./web-link-provider";
import { cacheTerminal, removeCached, takeCached, type CachedTerminal } from "./terminal-cache";
import { discardStaleCachedTerminal, getCachedTerminalRestorePlan } from "./terminal-restore";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";
import { applyTerminalAppearance } from "./terminal-appearance";
import { buildTerminalFontStack } from "./terminal-fonts";
import { createCodexTuiCompatTransform, transformTerminalOutputForCompat, type CodexTuiCompatTransform } from "./codex-tui-compat";
import { sendTerminalResize } from "./terminal-remote-resize";
import {
  pasteClipboardIntoTerminal,
} from "./terminal-rich-paste";
import {
  isCanonicalShellSessionId,
  isLegacyPtySessionId,
  terminalWebSocketPathForSession,
} from "./terminal-session-id";
import { createXtermLogger } from "./xterm-logger";
import type { TerminalCompatMode } from "@/stores/terminal-store";

const MAX_OSC52_BASE64_LENGTH = 1_000_000;
const OSC52_ALLOWED_TARGETS = new Set(["", "c", "p", "s", "0", "1", "2", "3", "4", "5", "6", "7"]);
const BRACKETED_PASTE_OPEN = "\u001b[200~";
const BRACKETED_PASTE_CLOSE = "\u001b[201~";
const BRACKETED_PASTE_OVERHEAD = BRACKETED_PASTE_OPEN.length + BRACKETED_PASTE_CLOSE.length;
const MAX_TERMINAL_INPUT = 65_536;
const SUPPORTED_TERMINAL_PASTE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const TERMINAL_PASTE_UPLOAD_TIMEOUT_MS = 30_000;
const TERMINAL_PASTE_MIME_BY_EXTENSION = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);
const TERMINAL_SCROLLBACK_LINES = 10_000;
const TERMINAL_SCROLL_SENSITIVITY = 1;
const TERMINAL_FAST_SCROLL_SENSITIVITY = 5;
const TERMINAL_LIVE_TAIL_FROM_SEQ = Number.MAX_SAFE_INTEGER;
const IMAGE_ADDON_OPTIONS: IImageAddonOptions = {
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

function shouldDisableWebglRenderer(suppressNativeKeyboard: boolean): boolean {
  if (suppressNativeKeyboard) return true;
  if (typeof navigator === "undefined") return false;
  const userAgent = navigator.userAgent;
  const isAppleMobile = /\b(iPad|iPhone|iPod)\b/.test(userAgent)
    || (userAgent.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const isSafari = /Safari\//.test(userAgent) && !/(Chrome|CriOS|FxiOS|EdgiOS)\//.test(userAgent);
  return isAppleMobile && isSafari;
}

function terminalPasteMimeType(file: File): string | null {
  const typed = file.type.trim().toLowerCase();
  if (SUPPORTED_TERMINAL_PASTE_MIME_TYPES.has(typed)) {
    return typed;
  }
  const dot = file.name.lastIndexOf(".");
  if (dot < 0) {
    return null;
  }
  return TERMINAL_PASTE_MIME_BY_EXTENSION.get(file.name.slice(dot).toLowerCase()) ?? null;
}

function isSupportedTerminalPasteFile(file: File | null | undefined): file is File {
  return Boolean(file && terminalPasteMimeType(file));
}

function filesFromTerminalFilePayload(payload: DataTransfer | ClipboardEvent["clipboardData"] | null): File[] {
  if (!payload) {
    return [];
  }
  const files: File[] = [];
  const items = Array.from(payload.items ?? []);
  for (const item of items) {
    if (item.kind === "file") {
      const file = item.getAsFile();
      if (isSupportedTerminalPasteFile(file)) {
        files.push(file);
      }
    }
  }
  if (files.length > 0) {
    return files;
  }
  return Array.from(payload.files ?? []).filter(isSupportedTerminalPasteFile);
}

function terminalPasteUploadTimeout(): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return { signal: AbortSignal.timeout(TERMINAL_PASTE_UPLOAD_TIMEOUT_MS), cleanup: () => {} };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TERMINAL_PASTE_UPLOAD_TIMEOUT_MS);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timeout),
  };
}

function splitBracketedPastePayload(parts: string[]): string[] {
  const maxPayloadLength = MAX_TERMINAL_INPUT - BRACKETED_PASTE_OVERHEAD;
  const payload = parts.filter((part) => part.length > 0).join(" ");
  const chunks: string[] = [];
  for (let index = 0; index < payload.length; index += maxPayloadLength) {
    chunks.push(payload.slice(index, index + maxPayloadLength));
  }
  return chunks;
}

function scrollTerminalViewportToBottom(term: Terminal | null): void {
  term?.scrollToBottom();
}

const AUTH_BANNER_BASE_STYLE: CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  right: 8,
  zIndex: 20,
  color: "#fff",
  borderRadius: 8,
  padding: "8px 12px",
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
};

const AUTH_BANNER_ACTION_STYLE: CSSProperties = {
  background: "rgba(255,255,255,0.2)",
  border: "1px solid rgba(255,255,255,0.3)",
  color: "#fff",
  borderRadius: 6,
  padding: "4px 12px",
  cursor: "pointer",
  fontSize: 13,
  whiteSpace: "nowrap",
};

type TerminalServerMessage =
  | { type: "attached"; sessionId: string; state: "running" | "exited"; exitCode: number | null; fromSeq: number | null }
  | { type: "output"; data: string; seq: number | null }
  | { type: "block-mark"; seq: number | null; mark: { code: "A" | "B" | "C" | "D"; exitCode?: number } }
  | { type: "replay-start" }
  | { type: "replay-end" }
  | { type: "exit"; code: number | null }
  | { type: "error"; message: string };

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stripTerminalControls(value: string): string {
  return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function parseTerminalServerMessage(raw: string): TerminalServerMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (_err: unknown) {
    return null;
  }

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  const msg = parsed as Record<string, unknown>;
  switch (msg.type) {
    case "attached": {
      const sessionId = typeof msg.sessionId === "string"
        ? msg.sessionId
        : typeof msg.session === "string"
          ? msg.session
          : null;
      if (!sessionId || (msg.state !== "running" && msg.state !== "exited")) {
        return null;
      }
      return {
        type: "attached",
        sessionId,
        state: msg.state,
        exitCode: toFiniteNumber(msg.exitCode),
        fromSeq: Number.isInteger(msg.fromSeq) && (msg.fromSeq as number) >= 0 ? (msg.fromSeq as number) : null,
      };
    }
    case "output":
      if (typeof msg.data !== "string") {
        return null;
      }
      return {
        type: "output",
        data: msg.data,
        seq: Number.isInteger(msg.seq) && (msg.seq as number) >= 0 ? (msg.seq as number) : null,
      };
    case "block-mark": {
      const mark = msg.mark;
      if (!mark || typeof mark !== "object" || !("code" in mark)) {
        return null;
      }
      const code = (mark as { code?: unknown }).code;
      if (code !== "A" && code !== "B" && code !== "C" && code !== "D") {
        return null;
      }
      const exitCode = toFiniteNumber((mark as { exitCode?: unknown }).exitCode);
      return {
        type: "block-mark",
        seq: Number.isInteger(msg.seq) && (msg.seq as number) >= 0 ? (msg.seq as number) : null,
        mark: exitCode === null ? { code } : { code, exitCode },
      };
    }
    case "replay-start":
      return { type: "replay-start" };
    case "replay-end":
      return { type: "replay-end" };
    case "exit":
      return { type: "exit", code: toFiniteNumber(msg.code) };
    case "error":
      return {
        type: "error",
        message: typeof msg.message === "string" ? msg.message : "Unknown error",
      };
    default:
      return null;
  }
}

function extractTrustedClaudeAuthUrl(raw: string): string | null {
  const stripped = raw
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x20\x7f-\x9f]/g, "");
  const match = stripped.match(/https:\/\/claude\.ai\/oauth\/authorize[^"'<>)]{0,2048}?state=[A-Za-z0-9_-]+/);
  if (!match) {
    return null;
  }

  try {
    const url = new URL(match[0]);
    const state = url.searchParams.get("state");
    const responseType = url.searchParams.get("response_type");
    const clientId = url.searchParams.get("client_id");
    if (
      url.origin !== "https://claude.ai" ||
      url.pathname !== "/oauth/authorize" ||
      responseType !== "code" ||
      !clientId ||
      !state ||
      !/^[A-Za-z0-9_-]+$/.test(state) ||
      url.searchParams.has("redirect")
    ) {
      return null;
    }
    return url.toString();
  } catch (_err: unknown) {
    return null;
  }
}

function terminalDebug(event: string, details: Record<string, unknown>): void {
  if (!isTerminalDebugEnabled()) {
    return;
  }
  console.info("[terminal-debug][pane]", event, details);
}

function suppressXtermNativeKeyboard(container: HTMLElement): void {
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

function applyXtermScrollSurface(xtermElement: HTMLElement | null | undefined): void {
  if (!xtermElement) {
    return;
  }

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

function applyXtermScrollOptions(term: Terminal): void {
  term.options.scrollback = TERMINAL_SCROLLBACK_LINES;
  term.options.scrollSensitivity = TERMINAL_SCROLL_SENSITIVITY;
  term.options.fastScrollSensitivity = TERMINAL_FAST_SCROLL_SENSITIVITY;
  term.options.scrollOnUserInput = true;
}

function refreshTerminalRenderer(term: Terminal): void {
  if (term.rows <= 0) {
    return;
  }
  term.refresh(0, term.rows - 1);
}

type DisposableWebglAddon = { dispose: () => void };

function toDisposableWebglAddon(addon: unknown): DisposableWebglAddon | null {
  if (!addon || typeof addon !== "object") {
    return null;
  }
  const dispose = (addon as { dispose?: unknown }).dispose;
  return typeof dispose === "function" ? (addon as DisposableWebglAddon) : null;
}

function terminalTelemetry(event: string, properties: Record<string, string | number | boolean | undefined>): void {
  const payload = {
    source: "terminal-pane",
    event,
    ...properties,
  };
  capturePostHogEvent("shell_terminal_ws", payload);
  capturePostHogLog(event.includes("error") ? "error" : "info", `terminal websocket ${event}`, payload);
}

function describeReadyState(ws: WebSocket | null): string {
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

interface TerminalPaneProps {
  paneId: string;
  cwd: string;
  theme: Theme;
  isFocused: boolean;
  sessionId?: string;
  claudeMode?: boolean;
  startupCommand?: string;
  compatMode?: TerminalCompatMode;
  onFocus?: (paneId: string) => void;
  onSessionAttached?: (paneId: string, sessionId: string) => void;
  isClosing?: boolean;
  shouldCacheOnUnmount?: (paneId: string) => boolean;
  shouldDestroyOnUnmount?: (paneId: string) => boolean;
  allowRemoteResize?: boolean;
  suppressNativeKeyboard?: boolean;
  /**
   * The CSS transform scale applied to the canvas ancestor. When the canvas is
   * zoomed via `transform: scale(z)`, xterm's mouse-to-cell mapping breaks
   * because getBoundingClientRect() returns scaled screen pixels while
   * cssCellWidth is measured at the unscaled font size. Providing the live zoom
   * factor allows TerminalPane to correct pointer events before xterm sees them.
   * Defaults to 1 (no correction).
   */
  canvasZoom?: number;
}

// react-doctor-disable-next-line react-doctor/no-giant-component, react-doctor/no-many-boolean-props -- cohesive xterm lifecycle owner: terminal creation, WS attach/replay, fit/resize, addon wiring, and caching are one tightly-coupled effect graph that cannot be split without leaking refs across components; the boolean props (isFocused, isClosing, allowRemoteResize, suppressNativeKeyboard) are independent terminal modes, not a hidden variant enum, so collapsing them into an options object would obscure call sites.
export function TerminalPane({
  paneId,
  cwd,
  theme,
  isFocused,
  sessionId: initialSessionId,
  claudeMode,
  startupCommand,
  compatMode,
  onFocus,
  onSessionAttached,
  isClosing,
  shouldCacheOnUnmount,
  shouldDestroyOnUnmount,
  allowRemoteResize = true,
  suppressNativeKeyboard = false,
  canvasZoom = 1,
}: TerminalPaneProps) {
  const terminalThemeId = useTerminalSettings((s) => s.themeId);
  const terminalFontSize = useTerminalSettings((s) => s.fontSize);
  const terminalFontFamily = useTerminalSettings((s) => s.fontFamily);
  const terminalLigatures = useTerminalSettings((s) => s.ligatures);
  const terminalCursorStyle = useTerminalSettings((s) => s.cursorStyle);
  const terminalSmoothScroll = useTerminalSettings((s) => s.smoothScroll);
  const cursorBlink = useTerminalSettings((s) => s.cursorBlink);
  // Visual-viewport state drives keyboard-aware re-fitting on mobile: when the
  // iOS soft keyboard opens the layout viewport doesn't shrink, so the terminal
  // host must re-fit to the visible band or the prompt hides behind the keyboard.
  const { height: viewportHeight, offsetTop: viewportOffsetTop, keyboardOpen } = useVisualViewport();
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<unknown>(null);
  const fitAddonRef = useRef<unknown>(null);
  const searchAddonRef = useRef<unknown>(null);
  const sessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const lastSeqRef = useRef<number>(0);
  const hasReplayCursorRef = useRef(false);
  const reconnectAttemptRef = useRef<number>(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingReconnectBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wsGenerationRef = useRef(0);
  const onSessionAttachedRef = useRef(onSessionAttached);
  const shouldCacheOnUnmountRef = useRef(shouldCacheOnUnmount);
  const shouldDestroyOnUnmountRef = useRef(shouldDestroyOnUnmount);
  const webglAddonRef = useRef<DisposableWebglAddon | null>(null);
  const webglContextLossDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const webglRecreateAttemptedRef = useRef(false);
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const onResizeDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const initialStartupCommandRef = useRef(startupCommand);
  const [searchOpen, setSearchOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<"reconnecting" | "disconnected" | null>(null);
  const outputBufferRef = useRef("");
  const commandBlockBufferRef = useRef("");
  const activeCommandBlockRef = useRef(false);
  const authDetectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isClosingRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof createSocketHealth> | null>(null);
  const isFocusedRef = useRef(isFocused);
  const allowRemoteResizeRef = useRef(allowRemoteResize);
  const compatModeRef = useRef<TerminalCompatMode | undefined>(compatMode);
  const codexCompatTransformRef = useRef<CodexTuiCompatTransform | null>(null);

  // Latest-value refs kept in sync during render so the long-lived init effect
  // (and the cleanup it returns) read current prop values without re-running and
  // tearing down the WebSocket/xterm session on every prop change. Writing these
  // during render rather than in an effect is intentional: it guarantees the
  // values are current before any event handler or the cleanup closure reads them.
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value ref sync (see comment above); moving to an effect would expose stale values to synchronous reads.
  onSessionAttachedRef.current = onSessionAttached;
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value ref sync; see onSessionAttachedRef above.
  shouldCacheOnUnmountRef.current = shouldCacheOnUnmount;
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value ref sync; see onSessionAttachedRef above.
  shouldDestroyOnUnmountRef.current = shouldDestroyOnUnmount;
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value ref sync; see onSessionAttachedRef above.
  isFocusedRef.current = isFocused;
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value ref sync; see onSessionAttachedRef above.
  allowRemoteResizeRef.current = allowRemoteResize;
  // react-doctor-disable-next-line react-hooks-js/refs, react-doctor/no-ref-current-in-render -- latest-value ref consumed by the long-lived WebSocket output handler without reconnecting on metadata changes.
  compatModeRef.current = compatMode;

  // Keep a stable ref to the current canvasZoom so the effect below can read
  // the latest value without being re-run (and re-registering listeners) on
  // every zoom change.
  // react-doctor-disable-next-line react-hooks-js/refs -- intentional latest-value ref sync; see onSessionAttachedRef above.
  const canvasZoomRef = useRef(canvasZoom);
  // react-doctor-disable-next-line react-hooks-js/refs, react-doctor/no-ref-current-in-render -- intentional latest-value ref sync; see onSessionAttachedRef above.
  canvasZoomRef.current = canvasZoom;

  // Canvas-zoom pointer correction.
  //
  // xterm maps pointer→cell as:
  //   col = (clientX − rect.left) / cssCellWidth
  // where rect = element.getBoundingClientRect() and cssCellWidth is measured
  // from the font at the unscaled element size.
  //
  // When a CSS `transform: scale(z)` is applied to a canvas ancestor the
  // element appears z× larger on screen. getBoundingClientRect() reflects the
  // scaled visual bounds, so `clientX − rect.left` is in *screen* pixels
  // (scaled by z). But cssCellWidth stays at the *unscaled* font metrics.
  // The division therefore gives col = truecol × z — off by the zoom factor.
  //
  // Fix: in capture phase, before xterm's own listeners see the event, emit a
  // synthetic MouseEvent whose clientX/Y are corrected to unscaled element
  // space: correctedClientX = rect.left + (clientX − rect.left) / zoom.
  // The original event is stopped so xterm never processes the scaled coords.
  //
  // Only active when zoom ≠ 1; at 1 no events are intercepted.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup -- cleanup is returned explicitly at the end of the effect body
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const MOUSE_EVENTS = ["mousedown", "mousemove", "mouseup"] as const;

    const correct = (e: MouseEvent) => {
      const zoom = canvasZoomRef.current;
      if (zoom === 1) return;

      // Find the actual xterm element — it is the direct child element that
      // xterm appended inside our container div (has class "xterm" or is the
      // first child element). Use the event target's closest xterm root.
      const xtermEl = container.querySelector(".xterm") as HTMLElement | null;
      const el = xtermEl ?? container;
      const rect = el.getBoundingClientRect();

      // Unscale: move the pointer back into element-space coordinates.
      const correctedX = rect.left + (e.clientX - rect.left) / zoom;
      const correctedY = rect.top + (e.clientY - rect.top) / zoom;

      // Stop xterm from processing the original (scaled) event.
      e.stopImmediatePropagation();

      // Dispatch a corrected synthetic event on the same target so xterm's
      // own capture listener (registered on the element, not window) sees it.
      // We must use `bubbles: false` + dispatch on the exact target xterm
      // registered on, which is the element the pointer landed on.
      const target = e.target instanceof Element ? e.target : el;
      const synthetic = new MouseEvent(e.type, {
        bubbles: e.bubbles,
        cancelable: e.cancelable,
        composed: e.composed,
        detail: e.detail,
        view: e.view ?? window,
        screenX: e.screenX,
        screenY: e.screenY,
        clientX: correctedX,
        clientY: correctedY,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        button: e.button,
        buttons: e.buttons,
        relatedTarget: e.relatedTarget,
        movementX: e.movementX,
        movementY: e.movementY,
      });
      // Mark the event so our own handler ignores it and does not re-correct.
      Object.defineProperty(synthetic, "_xtermZoomCorrected", { value: true });
      target.dispatchEvent(synthetic);
    };

    const handler = (e: MouseEvent) => {
      // Skip synthetic events we already corrected to avoid infinite loops.
      if ((e as MouseEvent & { _xtermZoomCorrected?: boolean })._xtermZoomCorrected) return;
      const zoom = canvasZoomRef.current;
      if (zoom === 1) return;
      correct(e);
    };

    for (const type of MOUSE_EVENTS) {
      // Capture phase so we intercept before xterm's own listeners.
      container.addEventListener(type, handler, { capture: true });
    }

    return () => {
      for (const type of MOUSE_EVENTS) {
        container.removeEventListener(type, handler, { capture: true });
      }
    };
  // Effect wires once and reads zoom through the ref — no dependency on
  // canvasZoom directly, which avoids tearing down/re-registering listeners
  // on every zoom change while the user is actively zooming the canvas.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFocus = () => {
    onFocus?.(paneId);
    (termRef.current as { focus?: () => void } | null)?.focus?.();
  };

  const showPasteError = (message = "Image paste failed. Try a smaller image or paste a saved file with `mos shell paste-file`.") => {
    setPasteError(message);
  };

  useEffect(() => {
    isClosingRef.current = !!isClosing;
  }, [isClosing]);

  useEffect(() => {
    // react-doctor-disable-next-line react-doctor/no-event-handler -- syncs the initialSessionId prop into a mutable ref consumed by the imperative WebSocket/PTY layer; this is prop->ref mirroring, not a DOM event handler, and has no parent handler to hoist into
    if (initialSessionId && initialSessionId !== sessionIdRef.current) {
      sessionIdRef.current = initialSessionId;
      lastSeqRef.current = 0;
      hasReplayCursorRef.current = false;
    }
  }, [initialSessionId]);

  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- this effect only registers paste/drop listeners; the fetch runs later from those user event handlers with an AbortSignal timeout.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const sendBracketedPaste = (terminalPaths: string[]) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        for (const chunk of splitBracketedPastePayload(terminalPaths)) {
          ws.send(JSON.stringify({
            type: "input",
            data: `${BRACKETED_PASTE_OPEN}${chunk}${BRACKETED_PASTE_CLOSE}`,
          }));
        }
      }
    };

    const uploadAndPasteFiles = async (files: File[]) => {
      const sessionId = sessionIdRef.current;
      if (!sessionId) {
        return;
      }
      const terminalPaths: string[] = [];
      let authToken: string | null = null;
      try {
        authToken = await getWebSocketAuthToken();
      } catch (err: unknown) {
        console.warn("Terminal paste auth token unavailable:", err instanceof Error ? err.message : err);
      }
      for (const file of files) {
        const mimeType = terminalPasteMimeType(file);
        if (!mimeType) {
          continue;
        }
        const uploadTimeout = terminalPasteUploadTimeout();
        // react-doctor-disable-next-line react-doctor/react-compiler-unsupported-syntax, react-hooks-js/todo -- try/finally guarantees each paste upload timeout is cleaned up after this user-triggered event handler finishes.
        try {
          const headers: Record<string, string> = {
            "Content-Type": mimeType,
            "X-Matrix-Filename": file.name,
          };
          if (authToken) {
            headers.Authorization = `Bearer ${authToken}`;
          }
          const url = new URL(`${getGatewayUrl()}/api/terminal/sessions/${encodeURIComponent(sessionId)}/paste-assets`);
          url.searchParams.set("cwd", cwd || "projects");
          // react-doctor-disable-next-line react-doctor/async-await-in-loop -- paste uploads are intentionally sequential to preserve terminal insertion order and avoid multiple simultaneous file bodies.
          const res = await fetch(url.toString(), {
            method: "POST",
            credentials: "same-origin",
            headers,
            signal: uploadTimeout.signal,
            body: file,
          });
          if (!res.ok) {
            console.warn(`Terminal paste upload failed: ${res.status}`);
            continue;
          }
          const payload = await res.json() as { terminalPath?: unknown };
          if (typeof payload.terminalPath === "string") {
            terminalPaths.push(payload.terminalPath);
          }
        } catch (err: unknown) {
          console.warn("Terminal paste upload failed:", err instanceof Error ? err.message : err);
        } finally {
          uploadTimeout.cleanup();
        }
      }
      if (terminalPaths.length > 0) {
        sendBracketedPaste(terminalPaths);
      }
    };

    const captureImagePayload = (event: ClipboardEvent | DragEvent): File[] => {
      const files = "clipboardData" in event
        ? filesFromTerminalFilePayload(event.clipboardData)
        : filesFromTerminalFilePayload(event.dataTransfer);
      if (files.length === 0) {
        return [];
      }
      event.preventDefault();
      event.stopPropagation();
      if ("stopImmediatePropagation" in event) {
        event.stopImmediatePropagation();
      }
      return files;
    };

    const onPaste = (event: ClipboardEvent) => {
      const files = captureImagePayload(event);
      if (files.length > 0) {
        void uploadAndPasteFiles(files);
      }
    };
    const onDrag = (event: DragEvent) => {
      captureImagePayload(event);
    };
    const onDrop = (event: DragEvent) => {
      const files = captureImagePayload(event);
      if (files.length > 0) {
        void uploadAndPasteFiles(files);
      }
    };

    container.addEventListener("paste", onPaste, { capture: true });
    container.addEventListener("dragenter", onDrag, { capture: true });
    container.addEventListener("dragover", onDrag, { capture: true });
    container.addEventListener("drop", onDrop, { capture: true });
    return () => {
      container.removeEventListener("paste", onPaste, { capture: true });
      container.removeEventListener("dragenter", onDrag, { capture: true });
      container.removeEventListener("dragover", onDrag, { capture: true });
      container.removeEventListener("drop", onDrop, { capture: true });
    };
  }, [cwd]);

  // Bridge for the mobile accessory key bar. TerminalApp dispatches a custom
  // window event with the target paneId; we forward to this pane's PTY if it
  // matches.
  useEffect(() => {
    const onKey = (e: Event) => {
      const detail = (e as CustomEvent<TerminalInputEventDetail>).detail;
      if (!detail || detail.paneId !== paneId) return;
      if (detail.action === "search") {
        setSearchOpen((prev) => !prev);
        return;
      }
      if (detail.action === "paste") {
        pasteClipboardIntoTerminal({
          clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
          gatewayUrl: getGatewayUrl(),
          ws: wsRef.current,
          submit: detail.submit === true,
        }).catch((err: unknown) => {
          console.warn("Clipboard paste failed:", err instanceof Error ? err.message : err);
          showPasteError("Clipboard paste failed. Try again or paste a saved file with `mos shell paste-file`.");
        });
        return;
      }
      if (!detail.data) return;
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data: detail.data }));
      }
    };
    window.addEventListener(TERMINAL_INPUT_EVENT, onKey as EventListener);
    return () => window.removeEventListener(TERMINAL_INPUT_EVENT, onKey as EventListener);
  }, [paneId]);

  // This effect owns the terminal's full lifecycle (WebSocket connect, xterm
  // bootstrap, reconnect timers, heartbeat). init() returns the real cleanup,
  // which is awaited and invoked in the outer return below — react-doctor's
  // cleanup heuristic does not see through the async indirection. The heartbeat
  // is intentionally stopped via the live heartbeatRef.current in cleanup so the
  // currently-running heartbeat (replaced on each reconnect) is the one stopped.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup, react-doctor/exhaustive-deps -- cleanup is returned via init()'s awaited promise (see outer return), and reading the live heartbeatRef.current in cleanup is required to stop the most recent heartbeat instance.
  useEffect(() => {
    let disposed = false;

    async function init() {
      const log = (event: string, details: Record<string, unknown> = {}) => {
        terminalDebug(event, {
          paneId,
          cwd,
          sessionId: sessionIdRef.current,
          lastSeq: lastSeqRef.current,
          hasReplayCursor: hasReplayCursorRef.current,
          wsState: describeReadyState(wsRef.current),
          ...details,
        });
      };

      const track = (event: string, details: Record<string, string | number | boolean | undefined> = {}) => {
        terminalTelemetry(event, {
          paneId,
          hasSession: Boolean(sessionIdRef.current),
          wsState: describeReadyState(wsRef.current),
          reconnectAttempt: reconnectAttemptRef.current,
          ...details,
        });
      };

      const webglDisabled = shouldDisableWebglRenderer(suppressNativeKeyboard);

      const clearAuthDetectTimer = () => {
        if (authDetectTimerRef.current) {
          clearTimeout(authDetectTimerRef.current);
          authDetectTimerRef.current = null;
        }
      };

      const clearReconnectTimer = () => {
        if (reconnectTimerRef.current) {
          clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
      };

      const clearPendingReconnectBanner = () => {
        if (pendingReconnectBannerTimerRef.current) {
          clearTimeout(pendingReconnectBannerTimerRef.current);
          pendingReconnectBannerTimerRef.current = null;
        }
      };

      // Tears down only the context-loss subscription (the closure that drives
      // DOM-renderer fallback). Cache paths dispose WebGL before detaching the
      // xterm element; destroy paths let term.dispose() dispose loaded addons.
      const teardownWebglSubscription = () => {
        webglContextLossDisposableRef.current?.dispose();
        webglContextLossDisposableRef.current = null;
      };

      // Fully disposes the WebGL renderer, dropping back to xterm's DOM
      // renderer (the default once no WebGL addon is loaded).
      const disposeWebgl = () => {
        teardownWebglSubscription();
        const addon = webglAddonRef.current;
        webglAddonRef.current = null;
        if (addon) {
          try {
            addon.dispose();
          } catch (err: unknown) {
            console.warn("WebGL addon dispose failed:", err instanceof Error ? err.message : err);
          }
        }
      };

      const container = containerRef.current;
      if (!container) {
        return;
      }

      // Check cache first — instant tab switch
      const cachedRestore = getCachedTerminalRestorePlan(takeCached(paneId));
      const cached = cachedRestore.cached;
      const canReuseCachedTerminal = cachedRestore.reuseTerminal;
      const canReuseCachedSocket = cachedRestore.reuseSocket;
      if (cached && !canReuseCachedTerminal) {
        sessionIdRef.current = cachedRestore.sessionId;
        lastSeqRef.current = cachedRestore.lastSeq;
        hasReplayCursorRef.current = cachedRestore.hasReplayCursor;
      }
      log("init", {
        cached: !!cached,
        reuseTerminal: canReuseCachedTerminal,
        reuseSocket: canReuseCachedSocket,
        cachedSessionId: cachedRestore.sessionId,
        cachedLastSeq: cachedRestore.lastSeq,
        cachedHasReplayCursor: cachedRestore.hasReplayCursor,
      });

      let term: Terminal;
      let fitAddon: FitAddon;
      let searchAddon: unknown = null;
      let webglAddon: unknown = null;
      const xtermTheme = buildXtermTheme(theme, terminalThemeId);
      codexCompatTransformRef.current = createCodexTuiCompatTransform(xtermTheme);

      const focusIfAllowed = () => {
        if (isFocusedRef.current && !suppressNativeKeyboard) {
          term.focus();
        }
      };

      const refitOnly = () => {
        if (disposed) {
          return;
        }
        try {
          fitAddon.fit();
          sendTerminalResize(wsRef.current, term, allowRemoteResizeRef.current);
          focusIfAllowed();
        } catch (err: unknown) {
          log("fit-failed", { message: err instanceof Error ? err.message : String(err) });
        }
      };

      const scheduleStableFit = () => {
        requestAnimationFrame(refitOnly);
        window.setTimeout(refitOnly, 80);
        window.setTimeout(refitOnly, 250);
      };

      // Subscribe to GPU context loss (common on mobile Safari, which drops GL
      // contexts under memory pressure / backgrounding). On loss: dispose the
      // WebGL renderer so xterm falls back to its DOM renderer, then attempt a
      // single re-create. We never leave a blank pane — the DOM renderer keeps
      // working even if re-creation fails.
      const wireWebglContextLoss = (addon: {
        onContextLoss: (cb: () => void) => { dispose: () => void };
      }) => {
        teardownWebglSubscription();
        webglContextLossDisposableRef.current = addon.onContextLoss(() => {
          log("webgl-context-loss", { recreateAttempted: webglRecreateAttemptedRef.current });
          disposeWebgl();
          if (!webglRecreateAttemptedRef.current && !disposed) {
            webglRecreateAttemptedRef.current = true;
            void enableWebgl();
          }
        });
      };

      // Instantiates and loads the WebGL renderer. Must run only after
      // term.open() + an initial fit(), and only client-side (browser-only
      // addon). Returns the addon, or null when WebGL is unavailable / fails —
      // in which case xterm keeps using the DOM renderer.
      const enableWebgl = async (): Promise<unknown> => {
        if (disposed || webglDisabled) {
          return null;
        }
        try {
          // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower dynamic import() expressions; lazy-loading the WebGL addon this way is intentional code-splitting, not a defect.
          const { WebglAddon } = await import("@xterm/addon-webgl");
          if (disposed) {
            return null;
          }
          const addon = new WebglAddon();
          term.loadAddon(addon);
          webglAddonRef.current = addon;
          wireWebglContextLoss(addon);
          log("webgl-enabled");
          return addon;
        } catch (err: unknown) {
          log("webgl-unavailable", { message: err instanceof Error ? err.message : String(err) });
          console.warn("WebGL renderer unavailable, using DOM renderer:", err instanceof Error ? err.message : err);
          disposeWebgl();
          return null;
        }
      };

      // Each init run starts with a fresh re-create budget (one retry).
      webglRecreateAttemptedRef.current = false;

      if (canReuseCachedTerminal && cached) {
        const termElement = (cached.terminal as { element?: HTMLElement }).element;
        if (termElement) {
          container.appendChild(termElement);
          applyXtermScrollSurface(termElement);
          if (suppressNativeKeyboard) {
            suppressXtermNativeKeyboard(container);
          }
        }
        term = cached.terminal;
        applyXtermScrollOptions(term);
        fitAddon = cached.fitAddon;
        searchAddon = cached.searchAddon;
        webglAddon = null;
        // Cached terminals intentionally never retain WebGL. Restore starts on
        // the DOM renderer, then re-enables WebGL after attach + fit.
        webglAddonRef.current = null;
        termRef.current = cached.terminal;
        fitAddonRef.current = cached.fitAddon;
        searchAddonRef.current = cached.searchAddon;
        wsRef.current = cached.ws;
        sessionIdRef.current = cachedRestore.sessionId;
        lastSeqRef.current = cachedRestore.lastSeq;
        hasReplayCursorRef.current = cachedRestore.hasReplayCursor;
        let restoredFitSucceeded = false;
        try {
          fitAddon.fit();
          sendTerminalResize(wsRef.current, term, allowRemoteResizeRef.current);
          restoredFitSucceeded = true;
        } catch (err: unknown) {
          log("fit-failed", { message: err instanceof Error ? err.message : String(err) });
        }
        refreshTerminalRenderer(term);
        scheduleStableFit();
        if (!webglDisabled && restoredFitSucceeded) {
          void enableWebgl().then((addon) => {
            webglAddon = addon;
          });
        }
      } else {
        // Cache miss — create fresh terminal
        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower dynamic import() expressions; lazy-loading xterm this way is intentional code-splitting, not a defect.
        const { Terminal: XTerm } = await import("@xterm/xterm");
        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower dynamic import() expressions; lazy-loading the fit addon this way is intentional code-splitting, not a defect.
        const { FitAddon } = await import("@xterm/addon-fit");

        if (disposed) return;

        const xterm = new XTerm({
          cursorBlink,
          cursorStyle: terminalCursorStyle,
          smoothScrollDuration: terminalSmoothScroll ? 125 : 0,
          scrollback: TERMINAL_SCROLLBACK_LINES,
          scrollSensitivity: TERMINAL_SCROLL_SENSITIVITY,
          fastScrollSensitivity: TERMINAL_FAST_SCROLL_SENSITIVITY,
          scrollOnUserInput: true,
          allowProposedApi: true,
          logger: createXtermLogger(),
          fontSize: terminalFontSize,
          fontFamily: buildTerminalFontStack(terminalFontFamily, theme.fonts?.mono),
          theme: xtermTheme,
          // Make ⌥ (Option) on macOS act as Meta — without this, Option+Left/Right
          // never reaches the shell as ESC-b / ESC-f, so word-jump is broken.
          macOptionIsMeta: true,
          // Send a Unicode bullet for Option+key combos that fall through to the
          // browser instead of producing accented characters.
          macOptionClickForcesSelection: true,
        });

        const nextFitAddon = new FitAddon();
        xterm.loadAddon(nextFitAddon);
        xterm.open(container);
        if (suppressNativeKeyboard) {
          suppressXtermNativeKeyboard(container);
        }
        const xtermElement = (xterm as { element?: HTMLElement }).element;
        if (xtermElement) {
          applyXtermScrollSurface(xtermElement);
          xtermElement.style.fontVariantLigatures = terminalLigatures ? "normal" : "none";
        }
        nextFitAddon.fit();

        term = xterm;
        fitAddon = nextFitAddon;
        termRef.current = xterm;
        fitAddonRef.current = nextFitAddon;
        scheduleStableFit();

        // GPU renderer — instantiated after open() + initial fit(). Falls back
        // to the DOM renderer automatically if WebGL is unavailable or the GL
        // context is later lost (see enableWebgl / wireWebglContextLoss).
        webglAddon = await enableWebgl();

        // Search addon
        try {
          // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower dynamic import() expressions; lazy-loading the search addon this way is intentional code-splitting, not a defect.
          const { SearchAddon } = await import("@xterm/addon-search");
          const addon = new SearchAddon();
          xterm.loadAddon(addon);
          searchAddon = addon;
          searchAddonRef.current = addon;
        } catch (_e: unknown) { /* unavailable */ }

        // Image protocol addon (sixel/iTerm2) with bounded client-side storage.
        try {
          xterm.loadAddon(new ImageAddon(IMAGE_ADDON_OPTIONS));
        } catch (err: unknown) {
          console.warn("Image addon initialization failed:", err instanceof Error ? err.message : err);
        }

        // Serialize addon
        try {
          // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower dynamic import() expressions; lazy-loading the serialize addon this way is intentional code-splitting, not a defect.
          const { SerializeAddon } = await import("@xterm/addon-serialize");
          xterm.loadAddon(new SerializeAddon());
        } catch (_e: unknown) { /* unavailable */ }

        // Link provider
        xterm.registerLinkProvider(new WebLinkProvider(xterm));

        // OSC 52 clipboard handler — used by TUIs (Claude Code, tmux, neovim, ...)
        // to copy text to the host clipboard. Format: "<Pc>;<Pd>" where Pc is the
        // selection target ("c", "p", "s", "0"-"7") and Pd is base64 or "?".
        try {
          xterm.parser.registerOscHandler(52, (data: string) => {
            const semi = data.indexOf(";");
            if (semi < 0) return false;
            const target = data.slice(0, semi);
            if (!OSC52_ALLOWED_TARGETS.has(target)) return false;
            const payload = data.slice(semi + 1);
            if (payload === "" || payload === "?") {
              // Query for current clipboard contents — we don't expose this.
              return true;
            }
            if (payload.length > MAX_OSC52_BASE64_LENGTH || !/^[A-Za-z0-9+/=]+$/.test(payload)) {
              return false;
            }
            let text: string;
            try {
              const bytes = Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0));
              text = new TextDecoder().decode(bytes);
            } catch (_err: unknown) {
              return false;
            }
            const fallbackCopy = () => {
              // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower try/finally; the finally clause guarantees the temporary textarea is removed regardless of copy outcome, which is the correct shape here.
              try {
                const ta = document.createElement("textarea");
                ta.value = text;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                ta.setAttribute("data-osc52-fallback", "true");
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
              } catch (err: unknown) {
                console.warn("OSC 52 fallback copy failed:", err instanceof Error ? err.message : err);
              } finally {
                document.querySelectorAll("textarea[data-osc52-fallback='true']").forEach((node) => node.remove());
              }
            };
            if (typeof navigator !== "undefined" && navigator.clipboard) {
              navigator.clipboard.writeText(text).catch((err: unknown) => {
                console.warn("OSC 52 clipboard write failed, using fallback:", err instanceof Error ? err.message : err);
                fallbackCopy();
              });
            } else {
              fallbackCopy();
            }
            return true;
          });
        } catch (err: unknown) {
          console.warn("Failed to register OSC 52 handler:", err instanceof Error ? err.message : err);
        }

        if (disposed) {
          xterm.dispose();
          return;
        }
      }

      if (isFocusedRef.current && !suppressNativeKeyboard) {
        requestAnimationFrame(() => {
          if (!disposed) {
            term.focus();
          }
        });
      }

      function bindWs(
        ws: WebSocket,
        attachOnOpen: boolean,
        options: { alreadyAttached?: boolean; generation?: number } = {},
      ) {
        const generation = options.generation ?? wsGenerationRef.current + 1;
        wsGenerationRef.current = generation;
        wsRef.current = ws;
        const alreadyAttached = options.alreadyAttached === true;
        const isCurrentWs = () => (
          wsRef.current === ws
          && wsGenerationRef.current === generation
          && !disposed
          && !isClosingRef.current
        );
        log("bind-ws", {
          attachOnOpen,
          alreadyAttached,
          boundWsState: describeReadyState(ws),
        });
        track("bind", { attachOnOpen, alreadyAttached, boundWsState: describeReadyState(ws) });

        const sendAttach = () => {
          if (!isCurrentWs() || ws.readyState !== WebSocket.OPEN) {
            return;
          }
          const currentSessionId = sessionIdRef.current;
          const isCanonicalShellSession = Boolean(currentSessionId && isCanonicalShellSessionId(currentSessionId));
          const attachMode = currentSessionId ? (isCanonicalShellSession ? "canonical" : "reattach") : "create";
          log("send-attach", {
            attachMode,
            attachSessionId: currentSessionId,
            fromSeq: lastSeqRef.current,
          });
          if (isCanonicalShellSession) {
            sendTerminalResize(ws, term, allowRemoteResizeRef.current);
            return;
          }
          if (currentSessionId) {
            ws.send(JSON.stringify({
              type: "attach",
              sessionId: currentSessionId,
              fromSeq: lastSeqRef.current,
            }));
          } else {
            ws.send(JSON.stringify({ type: "attach", cwd }));
          }

          sendTerminalResize(ws, term, allowRemoteResizeRef.current);

          const startup = sessionIdRef.current
            ? null
            : initialStartupCommandRef.current?.trim() || (claudeMode ? "claude" : null);
          if (startup) {
            setTimeout(() => {
              if (isCurrentWs() && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "input", data: `${startup}\r` }));
              }
            }, 100);
          }
        };

        ws.onopen = () => {
          if (!isCurrentWs()) {
            return;
          }
          reconnectAttemptRef.current = 0;
          clearReconnectTimer();
          clearPendingReconnectBanner();
          setConnectionNotice(null);
          log("ws-open", { attachOnOpen });
          track("open", { attachOnOpen });

          // Start heartbeat
          if (heartbeatRef.current) heartbeatRef.current.stop();
          heartbeatRef.current = createSocketHealth({
            pingIntervalMs: 30_000,
            pongTimeoutMs: 5_000,
            send: (data) => {
              if (isCurrentWs() && ws.readyState === WebSocket.OPEN) ws.send(data);
            },
            onDead: () => {
              if (isCurrentWs()) {
                ws.close(); // triggers onclose -> reconnect
              }
            },
          });
          heartbeatRef.current.start();

          if (attachOnOpen) {
            sendAttach();
          }
        };

        ws.onerror = () => {
          if (!isCurrentWs()) {
            return;
          }
          log("ws-error");
          track("error");
          if (!sessionIdRef.current) {
            term.write("\r\n\x1b[31mConnection error. Is the gateway running?\x1b[0m\r\n");
          }
        };

        ws.onclose = () => {
          if (!isCurrentWs()) {
            return;
          }
          wsRef.current = null;
          heartbeatRef.current?.stop();
          log("ws-close", {
            disposed,
            isClosing: isClosingRef.current,
            reconnectAttempt: reconnectAttemptRef.current,
          });
          track("close", {
            disposed,
            isClosing: isClosingRef.current,
          });
          if (disposed || isClosingRef.current) return;

          // Attempt reconnection with exponential backoff
          const attempt = reconnectAttemptRef.current;
          if (attempt < 3 && sessionIdRef.current) {
            clearReconnectTimer();
            const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
            reconnectAttemptRef.current = attempt + 1;
            log("schedule-reconnect", { delayMs: delay, nextAttempt: reconnectAttemptRef.current });
            track("schedule-reconnect", { delayMs: delay, nextAttempt: reconnectAttemptRef.current });
            clearPendingReconnectBanner();
            setConnectionNotice(null);
            pendingReconnectBannerTimerRef.current = setTimeout(() => {
              pendingReconnectBannerTimerRef.current = null;
              if (isCurrentWs() || (
                wsGenerationRef.current === generation
                && !disposed
                && !isClosingRef.current
                && wsRef.current === null
              )) {
                setConnectionNotice("reconnecting");
              }
            }, 750);
            reconnectTimerRef.current = setTimeout(() => {
              reconnectTimerRef.current = null;
              if (!disposed && !isClosingRef.current) {
                log("run-reconnect");
                connectWs();
              }
            }, delay);
          } else {
            setConnectionNotice("disconnected");
          }
        };

        ws.onmessage = (evt) => {
          if (!isCurrentWs()) {
            return;
          }
          const raw = typeof evt.data === "string" ? evt.data : "";
          // Fast pong handling (skip full parse)
          if (raw.includes('"pong"')) {
            try {
              const quick = JSON.parse(raw) as { type: string };
              if (quick.type === "pong") {
                heartbeatRef.current?.receivedPong();
                return;
              }
            } catch (_err: unknown) { /* fall through to normal parse */ }
          }

          const msg = parseTerminalServerMessage(raw);
          if (!msg) {
            return;
          }

          switch (msg.type) {
            case "attached":
              log("attached", {
                attachedSessionId: msg.sessionId,
                state: msg.state,
                exitCode: msg.exitCode ?? null,
                fromSeq: msg.fromSeq,
              });
              track("attached", {
                state: msg.state,
                hasExitCode: msg.exitCode != null,
              });
              sessionIdRef.current = msg.sessionId;
              if (msg.fromSeq !== null) {
                lastSeqRef.current = Math.max(lastSeqRef.current, msg.fromSeq);
                hasReplayCursorRef.current = true;
              }
              onSessionAttachedRef.current?.(paneId, msg.sessionId);
              if (msg.state === "exited") {
                const exitCode = msg.exitCode ?? "unknown";
                term.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
              }
              break;

            case "output":
              term.write(transformTerminalOutputForCompat(
                msg.data,
                compatModeRef.current,
                codexCompatTransformRef.current ?? createCodexTuiCompatTransform(buildXtermTheme(theme, terminalThemeId)),
              ));
              if (msg.seq !== null) {
                lastSeqRef.current = Math.max(lastSeqRef.current, msg.seq + 1);
                hasReplayCursorRef.current = true;
              }
              outputBufferRef.current += msg.data;
              if (outputBufferRef.current.length > 8192) {
                outputBufferRef.current = outputBufferRef.current.slice(-4096);
              }
              if (outputBufferRef.current.includes("claude.ai/oauth/authorize")) {
                clearAuthDetectTimer();
                authDetectTimerRef.current = setTimeout(() => {
                  authDetectTimerRef.current = null;
                  if (disposed) {
                    outputBufferRef.current = "";
                    return;
                  }
                  const nextAuthUrl = extractTrustedClaudeAuthUrl(outputBufferRef.current);
                  if (nextAuthUrl) {
                    setAuthUrl(nextAuthUrl);
                  }
                  outputBufferRef.current = "";
                }, 300);
              }
              if (activeCommandBlockRef.current) {
                commandBlockBufferRef.current += msg.data;
                if (commandBlockBufferRef.current.length > 1_000_000) {
                  commandBlockBufferRef.current = commandBlockBufferRef.current.slice(-1_000_000);
                }
              }
              break;

            case "block-mark":
              if (msg.seq !== null) {
                lastSeqRef.current = Math.max(lastSeqRef.current, msg.seq + 1);
                hasReplayCursorRef.current = true;
              }
              if (msg.mark.code === "B" || msg.mark.code === "C") {
                activeCommandBlockRef.current = true;
                commandBlockBufferRef.current = "";
              } else if (msg.mark.code === "D") {
                activeCommandBlockRef.current = false;
              }
              break;

            case "replay-start":
              clearAuthDetectTimer();
              outputBufferRef.current = "";
              break;
            case "replay-end":
              break;

            case "exit": {
              const code = msg.code ?? "unknown";
              term.write(`\r\n[Process exited with code ${code}]\r\n`);
              break;
            }

            case "error": {
              const safeMsg = stripTerminalControls(msg.message);
              log("server-error", { message: safeMsg });
              track("server-error", {
                sessionNotFound: safeMsg === "Session not found",
              });
              if (safeMsg === "Session not found" && sessionIdRef.current && isLegacyPtySessionId(sessionIdRef.current)) {
                log("session-not-found-reset");
                sessionIdRef.current = null;
                lastSeqRef.current = 0;
                hasReplayCursorRef.current = false;
                term.write("\r\n\x1b[33m[Session expired, starting new session...]\x1b[0m\r\n");
                log("fallback-create-after-session-not-found");
                ws.send(JSON.stringify({ type: "attach", cwd }));
              } else {
                term.write(`\r\n\x1b[31m[Error: ${safeMsg}]\x1b[0m\r\n`);
              }
              break;
            }
          }
        };

        if (!attachOnOpen && ws.readyState === WebSocket.OPEN) {
          if (alreadyAttached) {
            sendTerminalResize(ws, term, allowRemoteResizeRef.current);
            return;
          }
          sendAttach();
        }
      }

      function connectWs() {
        const generation = wsGenerationRef.current + 1;
        wsGenerationRef.current = generation;
        const currentSessionId = sessionIdRef.current;
        const wsPath = terminalWebSocketPathForSession(currentSessionId);
        const fromSeq = hasReplayCursorRef.current ? lastSeqRef.current : TERMINAL_LIVE_TAIL_FROM_SEQ;
        const query = currentSessionId && isCanonicalShellSessionId(currentSessionId)
          ? { session: currentSessionId, fromSeq: String(fromSeq) }
          : currentSessionId || !cwd
            ? undefined
            : { cwd };
        const queryCwd = query && "cwd" in query ? query.cwd : null;
        const querySession = query && "session" in query ? query.session : null;
        log("connect-ws", {
          wsPath,
          queryCwd,
          querySession,
          reconnectAttempt: reconnectAttemptRef.current,
        });

        void buildAuthenticatedWebSocketUrl(wsPath, query)
          .catch((err: unknown) => {
            console.warn(
              "[terminal] Falling back to unauthenticated terminal websocket URL:",
              err instanceof Error ? err.message : err,
            );
            const baseWs = getGatewayWs().replace("/ws", wsPath);
            const url = new URL(baseWs);
            for (const [key, value] of Object.entries(query ?? {})) {
              if (value) url.searchParams.set(key, value);
            }
            return url.toString();
          })
          .then((wsUrl) => {
            if (generation !== wsGenerationRef.current || disposed || isClosingRef.current) {
              const reason = generation !== wsGenerationRef.current
                ? "stale"
                : disposed
                  ? "disposed"
                  : "closing";
              log("connect-ws-abort", { reason });
              track("connect-abort", { reason });
              return;
            }
            log("connect-ws-url", {
              urlIncludesCwd: wsUrl.includes("cwd="),
              urlIncludesToken: wsUrl.includes("token="),
            });
            track("connect", {
              urlIncludesToken: wsUrl.includes("token="),
              hasCwdQuery: wsUrl.includes("cwd="),
            });
            const previousWs = wsRef.current;
            if (previousWs && previousWs.readyState !== WebSocket.CLOSED) {
              previousWs.onopen = null;
              previousWs.onclose = null;
              previousWs.onerror = null;
              previousWs.onmessage = null;
              previousWs.close();
            }
            const ws = new WebSocket(wsUrl);
            bindWs(ws, true, { generation });
          });
      }

      if (cached && canReuseCachedSocket) {
        bindWs(cached.ws, cached.ws.readyState === WebSocket.CONNECTING, {
          alreadyAttached: cached.ws.readyState === WebSocket.OPEN,
        });
      } else {
        if (cached && !canReuseCachedTerminal) {
          discardStaleCachedTerminal(cached);
        }
        connectWs();
      }

      const onVisibilityChange = () => {
        log("visibilitychange", { visibilityState: document.visibilityState });
        if (document.visibilityState === "visible") {
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            log("visibility-ping-now");
            heartbeatRef.current?.pingNow();
          } else if (!disposed && !isClosingRef.current && sessionIdRef.current) {
            // Disconnected while hidden, reconnect now
            reconnectAttemptRef.current = 0;
            clearReconnectTimer();
            clearPendingReconnectBanner();
            setConnectionNotice(null);
            log("visibility-reconnect-now");
            connectWs();
          }
        }
      };

      document.addEventListener("visibilitychange", onVisibilityChange);

      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      onResizeDisposableRef.current?.dispose();
      onResizeDisposableRef.current = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        sendTerminalResize(wsRef.current, { cols, rows }, allowRemoteResizeRef.current);
      });

      // Keyboard shortcuts
      const sendRaw = (data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      };

      term.attachCustomKeyEventHandler((ev: KeyboardEvent) => {
        if (ev.type !== "keydown") return true;

        if (ev.ctrlKey && ev.shiftKey && ev.key === "F") {
          setSearchOpen((prev) => !prev);
          return false;
        }

        if (ev.ctrlKey && ev.shiftKey && ev.key === "C") {
          const selection = term.getSelection();
          if (selection) {
            navigator.clipboard.writeText(selection).catch((err: unknown) => {
              console.warn("Clipboard copy failed:", err instanceof Error ? err.message : err);
            });
            term.clearSelection();
            return false;
          }
          return true;
        }

        if (ev.altKey && ev.shiftKey && ev.key.toUpperCase() === "C") {
          const block = commandBlockBufferRef.current.trim();
          if (block) {
            navigator.clipboard.writeText(block).catch((err: unknown) => {
              console.warn("Command block copy failed:", err instanceof Error ? err.message : err);
            });
            return false;
          }
          return true;
        }

        if (ev.ctrlKey && ev.shiftKey && ev.key === "V") {
          pasteClipboardIntoTerminal({
            clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
            gatewayUrl: getGatewayUrl(),
            ws: wsRef.current,
            submit: ev.altKey,
          }).catch((err: unknown) => {
            console.warn("Clipboard paste failed:", err instanceof Error ? err.message : err);
            showPasteError("Clipboard paste failed. Try again or paste a saved file with `mos shell paste-file`.");
          });
          return false;
        }

        // macOS-style line-editing shortcuts. The browser only delivers
        // Cmd-arrow events to us when the focus is inside xterm; otherwise
        // the OS swallows them. We map them to the readline-equivalent
        // control sequences so bash/zsh, claude, pi, etc. all behave
        // predictably regardless of OS keymap.
        if (ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          if (ev.key === "ArrowLeft") {
            sendRaw("\x01"); // Ctrl-A — beginning of line
            return false;
          }
          if (ev.key === "ArrowRight") {
            sendRaw("\x05"); // Ctrl-E — end of line
            return false;
          }
          if (ev.key === "Backspace") {
            sendRaw("\x15"); // Ctrl-U — kill to start of line
            return false;
          }
          if (ev.key === "ArrowUp") {
            sendRaw("\x1b[1;5H"); // scroll-to-top emulation: Home with Ctrl mod
            return false;
          }
        }

        return true;
      });

      const resizeObserver = new ResizeObserver(() => {
        requestAnimationFrame(refitOnly);
      });
      resizeObserver.observe(container);

      return () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        resizeObserver.disconnect();
        clearAuthDetectTimer();
        clearReconnectTimer();
        clearPendingReconnectBanner();
        heartbeatRef.current?.stop();
        // Drop the context-loss subscription on every path. Cache paths dispose
        // the live WebGL renderer before detaching the retained xterm element;
        // destroy paths let term.dispose() dispose loaded addons.
        teardownWebglSubscription();
        onDataDisposableRef.current?.dispose();
        onDataDisposableRef.current = null;
        onResizeDisposableRef.current?.dispose();
        onResizeDisposableRef.current = null;
        const shouldCache = !isClosingRef.current && (shouldCacheOnUnmountRef.current?.(paneId) ?? true);
        const shouldDestroy = shouldDestroyOnUnmountRef.current?.(paneId) ?? false;
        log("cleanup", {
          shouldCache,
          shouldDestroy,
          isClosing: isClosingRef.current,
          paneStillInTree: shouldCacheOnUnmountRef.current?.(paneId) ?? true,
        });

        if (!shouldCache) {
          // Plain unmounts should not destroy the session. Explicit pane/tab close
          // may still need to destroy a just-created session before layout state
          // has been updated with its session id.
          const ws = wsRef.current;
          if (ws && ws.readyState === WebSocket.OPEN) {
            if (shouldDestroy) {
              log("cleanup-destroy-via-ws");
              ws.send(JSON.stringify({ type: "destroy" }));
            } else {
              log("cleanup-detach-via-ws");
              ws.send(JSON.stringify({ type: "detach" }));
            }
          }
          ws?.close();
          removeCached(paneId);
          term.dispose(); // disposes loaded addons, including the WebGL renderer
          webglAddonRef.current = null;
        } else if (wsRef.current) {
          // Tab switch — cache the terminal for instant restore
          log("cleanup-cache-terminal");
          const retainedWebglAddon = webglAddonRef.current ?? toDisposableWebglAddon(webglAddon);
          if (retainedWebglAddon && !webglAddonRef.current) {
            webglAddonRef.current = retainedWebglAddon;
          }
          log("webgl-disposed-before-cache", { hadWebgl: Boolean(retainedWebglAddon) });
          disposeWebgl();
          webglAddon = null;
          const termElement = (term as { element?: HTMLElement }).element;
          if (termElement?.parentNode) {
            termElement.parentNode.removeChild(termElement);
          }

          const cachedSessionId = sessionIdRef.current ?? "";
          const retainSocket = !isCanonicalShellSessionId(cachedSessionId);
          cacheTerminal(paneId, {
            terminal: term,
            fitAddon,
            webglAddon: null,
            searchAddon,
            ws: wsRef.current,
            lastSeq: lastSeqRef.current,
            hasReplayCursor: hasReplayCursorRef.current,
            sessionId: cachedSessionId,
          }, { retainSocket });
        } else {
          // WS never established — dispose, don't cache
          log("cleanup-dispose-no-ws");
          term.dispose(); // disposes loaded addons, including the WebGL renderer
          webglAddonRef.current = null;
        }
      };
    }

    const cleanup = init();

    return () => {
      disposed = true;
      cleanup.then((fn) => fn?.());
    };
    // react-doctor-disable-next-line react-doctor/exhaustive-deps -- theme/font/cursor settings are deliberately excluded: re-running this effect would tear down and rebuild the WebSocket and xterm session. Those settings are applied live by the separate options-sync effect below, and live prop values are read through latest-value refs.
  }, [
    claudeMode,
    cwd,
    allowRemoteResize,
    paneId,
    suppressNativeKeyboard,
  ]);

  useEffect(() => {
    const xtermTheme = buildXtermTheme(theme, terminalThemeId);
    codexCompatTransformRef.current = createCodexTuiCompatTransform(xtermTheme);

    if (termRef.current && fitAddonRef.current) {
      applyTerminalAppearance(
        termRef.current as Parameters<typeof applyTerminalAppearance>[0],
        fitAddonRef.current as Parameters<typeof applyTerminalAppearance>[1],
        {
          theme: xtermTheme,
          fontFamily: buildTerminalFontStack(terminalFontFamily, theme.fonts?.mono),
          fontSize: terminalFontSize,
          cursorBlink,
          cursorStyle: terminalCursorStyle,
          smoothScrollDuration: terminalSmoothScroll ? 125 : 0,
          ligatures: terminalLigatures,
        },
      );
    }
  }, [
    cursorBlink,
    terminalCursorStyle,
    terminalFontFamily,
    terminalFontSize,
    terminalLigatures,
    terminalSmoothScroll,
    terminalThemeId,
    theme,
  ]);

  useEffect(() => {
    if (isFocused && !suppressNativeKeyboard && termRef.current) {
      (termRef.current as { focus: () => void }).focus();
    }
  }, [isFocused, suppressNativeKeyboard]);

  // Re-fit the terminal whenever the visual viewport changes (soft keyboard
  // open/close, URL-bar collapse, orientation). The document viewport is
  // resized by `interactiveWidget: "resizes-content"`; the terminal host does
  // not subtract a keyboard CSS var, so these passes only recompute rows/cols
  // and keep the prompt visible after mobile keyboard transitions settle.
  useEffect(() => {
    const fit = fitAddonRef.current as { fit?: () => void } | null;
    if (!fit?.fit) return;
    const refit = () => {
      try {
        fit.fit?.();
        sendTerminalResize(
          wsRef.current,
          termRef.current as Parameters<typeof sendTerminalResize>[1],
          allowRemoteResizeRef.current,
        );
        if (suppressNativeKeyboard) {
          scrollTerminalViewportToBottom(termRef.current as Terminal | null);
        }
        if (isFocusedRef.current && !suppressNativeKeyboard) {
          (termRef.current as { focus?: () => void } | null)?.focus?.();
        }
      } catch (err: unknown) {
        console.warn("Terminal viewport re-fit failed:", err instanceof Error ? err.message : err);
      }
    };
    const id = requestAnimationFrame(refit);
    const settleId = suppressNativeKeyboard ? window.setTimeout(refit, 220) : null;
    return () => {
      cancelAnimationFrame(id);
      if (settleId !== null) {
        window.clearTimeout(settleId);
      }
    };
  }, [viewportHeight, viewportOffsetTop, keyboardOpen, suppressNativeKeyboard]);

  useEffect(() => {
    if (!pasteError) return;
    const timer = window.setTimeout(() => setPasteError(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [pasteError]);

  return (
    // react-doctor-disable-next-line react-doctor/no-static-element-interactions, react-doctor/click-events-have-key-events -- presentational click-to-focus wrapper: clicking anywhere in the pane forwards focus to the embedded xterm terminal, which is itself the keyboard-interactive element (its textarea is in natural tab order). This div is not a control, so a role/tabIndex would be misleading; keyboard users interact with the terminal directly.
    <div
      ref={containerRef}
      // ph-no-capture: terminal output can contain secrets (env vars, tokens,
      // file contents); PostHog session replay blocks this element natively.
      className="ph-no-capture h-full w-full min-h-0 min-w-0 relative overflow-hidden"
      style={{
        outline: isFocused ? "1px solid var(--primary)" : "none",
        outlineOffset: "-1px",
        // Left gutter so the prompt isn't jammed against the window edge.
        paddingLeft: 12,
      }}
      onPointerDown={handleFocus}
      onClick={handleFocus}
    >
      {pasteError && (
        <div
          role="status"
          aria-live="polite"
          style={{
            ...AUTH_BANNER_BASE_STYLE,
            top: authUrl ? 76 : 8,
            background: "rgba(127, 29, 29, 0.95)",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>{pasteError}</div>
          <button
            type="button"
            onClick={() => setPasteError(null)}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.78)",
              cursor: "pointer",
              fontSize: 16,
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
      )}
      {connectionNotice && !pasteError && (
        <div
          role="status"
          aria-live="polite"
          style={{
            ...AUTH_BANNER_BASE_STYLE,
            top: authUrl ? 76 : 8,
            left: "50%",
            right: "auto",
            transform: "translateX(-50%)",
            width: "max-content",
            maxWidth: "calc(100% - 32px)",
            background: connectionNotice === "reconnecting"
              ? "rgba(146, 64, 14, 0.95)"
              : "rgba(63, 63, 70, 0.95)",
          }}
        >
          {connectionNotice === "reconnecting" ? "Reconnecting terminal..." : "Terminal disconnected"}
        </div>
      )}
      {authUrl && (
        <div
          style={{
            ...AUTH_BANNER_BASE_STYLE,
            background: theme.colors.primary || "#c2703a",
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div>Claude Code login required</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Detected from terminal output. Terminal apps can spoof this. Only continue if you initiated Claude Code login.
            </div>
            <div
              style={{
                fontSize: 12,
                opacity: 0.9,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={authUrl}
            >
              {authUrl}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              window.open(authUrl, "_blank", "noopener,noreferrer");
            }}
            style={AUTH_BANNER_ACTION_STYLE}
          >
            Open login
          </button>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(authUrl).catch((_err: unknown) => {
                // Fallback for insecure contexts / iframe restrictions
                const ta = document.createElement("textarea");
                ta.value = authUrl;
                ta.style.position = "fixed";
                ta.style.opacity = "0";
                document.body.appendChild(ta);
                ta.select();
                document.execCommand("copy");
                document.body.removeChild(ta);
              });
            }}
            style={AUTH_BANNER_ACTION_STYLE}
          >
            Copy URL
          </button>
          <button
            type="button"
            onClick={() => setAuthUrl(null)}
            style={{
              background: "none",
              border: "none",
              color: "rgba(255,255,255,0.7)",
              cursor: "pointer",
              fontSize: 16,
              padding: "0 4px",
              lineHeight: 1,
            }}
          >
            x
          </button>
        </div>
      )}
      {/* Reading the imperative xterm search-addon handle during render is
          intentional: the addon is created inside the init effect and is stable
          thereafter; searchOpen state (not the ref) drives re-render, so these
          reads only gate whether the overlay mounts and supply its handle. */}
      {/* react-doctor-disable-next-line react-hooks-js/refs -- intentional stable imperative-handle read during render; see comment above. */}
      {searchOpen && !!searchAddonRef.current && (
        <TerminalSearchBar
          // react-doctor-disable-next-line react-hooks-js/refs -- intentional stable imperative-handle read during render; see comment above.
          searchAddon={searchAddonRef.current as Parameters<typeof TerminalSearchBar>[0]["searchAddon"]}
          isOpen={searchOpen}
          onClose={() => setSearchOpen(false)}
          theme={theme}
        />
      )}
    </div>
  );
}
