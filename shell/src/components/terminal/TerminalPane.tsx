"use client";

import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from "react";
import { getGatewayUrl, getGatewayWs } from "@/lib/gateway";
import { createSocketHealth } from "@/lib/socket-health";
import { useTerminalSettings } from "@/stores/terminal-settings";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";
import type { Theme } from "@/hooks/useTheme";
import { useVisualViewport } from "@/hooks/useVisualViewport";
import { ImageAddon } from "@xterm/addon-image";
import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  classifyTerminalClipboardShortcut,
  classifyTerminalPointerEvent,
} from "@matrix-os/contracts";
import type { TerminalFontFamily, TerminalThemeId } from "@/stores/terminal-settings";
import { buildXtermTheme, getTerminalMinimumContrastRatio } from "./terminal-themes";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { TerminalLinksTray } from "./TerminalLinksTray";
import { TerminalLinkContextMenu, type TerminalLinkMenuState } from "./TerminalLinkContextMenu";
import {
  INITIAL_TERMINAL_LINKS_STATE,
  activateTerminalLink,
  copyTerminalLink,
  findTerminalLinkAtCell,
  mayContainTerminalLink,
  openTerminalLink,
  scanTerminalLinkOutput,
  terminalCellFromPointer,
  terminalLinksReducer,
} from "./terminal-links";
import { WebLinkProvider } from "./web-link-provider";
import { cacheTerminal, removeCached, takeCached, type CachedTerminal } from "./terminal-cache";
import {
  closeStaleCachedSocket,
  discardStaleCachedTerminal,
  getCachedTerminalRestorePlan,
} from "./terminal-restore";
import { TERMINAL_INPUT_EVENT, type TerminalInputEventDetail } from "./terminal-input-event";
import { applyTerminalAppearance } from "./terminal-appearance";
import { buildTerminalFontStack } from "./terminal-fonts";
import { createCodexTuiCompatTransform, transformTerminalOutputForCompat, type CodexTuiCompatTransform } from "./codex-tui-compat";
import { sendTerminalResize } from "./terminal-remote-resize";
import {
  computeSoftGridLayout,
  correctTerminalPointerCoordinates,
} from "./terminal-soft-grid";
import {
  pasteClipboardIntoTerminal,
} from "./terminal-rich-paste";
import {
  IMAGE_ADDON_OPTIONS,
  MAX_OSC52_BASE64_LENGTH,
  OSC52_ALLOWED_TARGETS,
  TERMINAL_CANONICAL_MAX_COLS,
  TERMINAL_CANONICAL_MAX_ROWS,
  TERMINAL_FAST_SCROLL_SENSITIVITY,
  TERMINAL_MINIMUM_READABLE_FONT_SIZE,
  TERMINAL_SCROLLBACK_LINES,
  TERMINAL_SCROLL_SENSITIVITY,
  applyXtermScrollOptions,
  applyXtermScrollSurface,
  applyXtermSurfaceBackground,
  describeReadyState,
  isAppleCommandPlatform,
  refreshTerminalRenderer,
  scrollTerminalViewportToBottom,
  shouldDisableWebglRenderer,
  suppressXtermNativeKeyboard,
  terminalDebug,
  terminalTelemetry,
  toDisposableWebglAddon,
  type CanonicalReplayRequest,
  type DisposableWebglAddon,
} from "./terminal-xterm-runtime";
import {
  isCanonicalShellSessionId,
  isLegacyPtySessionId,
  terminalWebSocketPathForSession,
} from "./terminal-session-id";
import { createXtermLogger } from "./xterm-logger";
import { createColdReplayVisibility, type ColdReplayVisibility } from "./cold-replay-visibility";
import { parseTerminalServerMessage, stripTerminalControls } from "./terminal-server-message";
import { useTerminalFocusRequest } from "./useTerminalFocusRequest";
import { useTerminalFilePaste } from "./useTerminalFilePaste";
import type { TerminalCompatMode } from "@/stores/terminal-store";

const TERMINAL_OVERLAY_BASE_STYLE: CSSProperties = {
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
interface TerminalPaneProps {
  paneId: string;
  cwd: string;
  theme: Theme;
  isFocused: boolean;
  focusRequestId?: number;
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
  focusRequestId = 0,
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
  const terminalSurfaceBackground = buildXtermTheme(theme, terminalThemeId).background;
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
  const [terminalLinks, dispatchTerminalLinks] = useReducer(
    terminalLinksReducer,
    INITIAL_TERMINAL_LINKS_STATE,
  );
  const [linkContextMenu, setLinkContextMenu] = useState<TerminalLinkMenuState | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [connectionNotice, setConnectionNotice] = useState<"reconnecting" | "disconnected" | "elsewhere" | null>(null);
  const resumeLeaseRef = useRef<() => void>(() => undefined);
  const wasFocusedRef = useRef(isFocused);
  const outputBufferRef = useRef("");
  const commandBlockBufferRef = useRef("");
  const activeCommandBlockRef = useRef(false);
  const linkDetectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isClosingRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof createSocketHealth> | null>(null);
  const isFocusedRef = useRef(isFocused);
  const allowRemoteResizeRef = useRef(allowRemoteResize);
  const compatModeRef = useRef<TerminalCompatMode | undefined>(compatMode);
  const codexCompatTransformRef = useRef<CodexTuiCompatTransform | null>(null);
  const softGridScaleRef = useRef(1);
  const softGridLayoutRef = useRef<(() => void) | null>(null);
  const hardGridMeasureRef = useRef<(() => void) | null>(null);
  const terminalFontSizeRef = useRef(terminalFontSize);
  const collapseTerminalLinks = useCallback(() => {
    dispatchTerminalLinks({ type: "collapse" });
  }, []);
  const dismissTerminalLinks = useCallback(() => {
    dispatchTerminalLinks({ type: "dismiss" });
  }, []);
  const closeLinkContextMenu = useCallback(() => {
    setLinkContextMenu(null);
    (termRef.current as Terminal | null)?.focus();
  }, []);
  const copyTerminalSelection = useCallback((selection: string) => {
    if (!navigator.clipboard?.writeText) {
      setPasteError("Clipboard copy failed. Try again.");
      return;
    }
    void navigator.clipboard.writeText(selection).catch((error: unknown) => {
      console.warn("[terminal] clipboard copy unavailable", {
        category: error instanceof DOMException ? error.name : "clipboard-error",
      });
      setPasteError("Clipboard copy failed. Try again.");
    });
  }, []);
  const selectAllTerminal = useCallback(() => {
    (termRef.current as Terminal | null)?.selectAll();
  }, []);

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
  // react-doctor-disable-next-line react-hooks-js/refs, react-doctor/no-ref-current-in-render -- the long-lived terminal lifecycle reads the latest configured font size without reconnecting the WebSocket.
  terminalFontSizeRef.current = terminalFontSize;

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
      const visualScale = canvasZoomRef.current * softGridScaleRef.current;
      if (visualScale === 1) return;

      // Find the actual xterm element — it is the direct child element that
      // xterm appended inside our container div (has class "xterm" or is the
      // first child element). Use the event target's closest xterm root.
      const xtermEl = container.querySelector(".xterm") as HTMLElement | null;
      const el = xtermEl ?? container;
      const rect = el.getBoundingClientRect();

      // Unscale: move the pointer back into element-space coordinates.
      const corrected = correctTerminalPointerCoordinates({
        clientX: e.clientX,
        clientY: e.clientY,
        rectLeft: rect.left,
        rectTop: rect.top,
        canvasZoom: canvasZoomRef.current,
        gridScale: softGridScaleRef.current,
      });

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
        clientX: corrected.clientX,
        clientY: corrected.clientY,
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
      const terminal = termRef.current as Terminal | null;
      if (terminal) {
        const decision = classifyTerminalPointerEvent({
          type: e.type as "mousedown" | "mousemove" | "mouseup",
          button: e.button,
          buttons: e.buttons,
          hasSelection: terminal.hasSelection(),
        });
        if (decision === "shield-selection") {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
      }
      const visualScale = canvasZoomRef.current * softGridScaleRef.current;
      if (visualScale === 1) return;
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

  useTerminalFilePaste({ containerRef, cwd, sessionIdRef, wsRef });

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
    let leaseWasRevoked = false;

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

      const clearLinkDetectTimer = () => {
        if (linkDetectTimerRef.current) {
          clearTimeout(linkDetectTimerRef.current);
          linkDetectTimerRef.current = null;
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
      let coldReplayVisibility: ColdReplayVisibility | null = null;
      let softGridLayoutFrame: number | null = null;
      let hardGridMeasureFrame: number | null = null;
      let lastDeclaredHardSize: { cols: number; rows: number } | null = null;
      let webSocketConnectPending = false;
      const xtermTheme = buildXtermTheme(theme, terminalThemeId);
      codexCompatTransformRef.current = createCodexTuiCompatTransform(xtermTheme);

      const usesCanonicalGrid = () => {
        const currentSessionId = sessionIdRef.current;
        return Boolean(currentSessionId && isCanonicalShellSessionId(currentSessionId));
      };
      const usesSoftGrid = () => usesCanonicalGrid() && suppressNativeKeyboard;
      const usesHardGrid = () => usesCanonicalGrid() && !suppressNativeKeyboard;

      const unscaledElementSize = (
        element: HTMLElement,
        dimension: "width" | "height",
      ): number => {
        const offset = dimension === "width" ? element.offsetWidth : element.offsetHeight;
        if (offset > 0) {
          return offset;
        }
        const styled = Number.parseFloat(element.style[dimension]);
        if (Number.isFinite(styled) && styled > 0) {
          return styled;
        }
        const rect = element.getBoundingClientRect();
        const transformed = dimension === "width" ? rect.width : rect.height;
        return transformed > 0 ? transformed / softGridScaleRef.current : 0;
      };

      const applySoftGridLayout = () => {
        if (disposed || !usesSoftGrid()) {
          return;
        }
        const termElement = term.element;
        const screen = termElement?.querySelector(".xterm-screen");
        if (!termElement || !(screen instanceof HTMLElement)) {
          return;
        }
        const gridWidth = unscaledElementSize(screen, "width");
        const gridHeight = unscaledElementSize(screen, "height");
        if (gridWidth <= 0 || gridHeight <= 0) {
          return;
        }
        const currentFontSize = typeof term.options.fontSize === "number"
          ? term.options.fontSize
          : terminalFontSizeRef.current;
        const configuredFontSize = terminalFontSizeRef.current;
        const baseGridWidth = gridWidth * (configuredFontSize / currentFontSize);
        const baseGridHeight = gridHeight * (configuredFontSize / currentFontSize);
        const layout = computeSoftGridLayout({
          viewportWidth: container.clientWidth,
          viewportHeight: container.clientHeight,
          gridWidth: baseGridWidth,
          gridHeight: baseGridHeight,
          configuredFontSize,
          minimumReadableFontSize: TERMINAL_MINIMUM_READABLE_FONT_SIZE,
          devicePixelRatio: window.devicePixelRatio,
        });
        if (Math.abs(currentFontSize - layout.fontSize) > 0.01) {
          term.options.fontSize = layout.fontSize;
        }
        softGridScaleRef.current = layout.scale;
        termElement.style.transformOrigin = "top left";
        termElement.style.transform = `scale(${layout.scale})`;
        container.style.overflowX = layout.panX ? "auto" : "hidden";
        container.style.overflowY = layout.panY ? "auto" : "hidden";
      };

      const scheduleSoftGridLayout = () => {
        if (disposed || softGridLayoutFrame !== null) {
          return;
        }
        softGridLayoutFrame = requestAnimationFrame(() => {
          softGridLayoutFrame = null;
          applySoftGridLayout();
        });
      };

      const clearSoftGridLayout = () => {
        softGridScaleRef.current = 1;
        const termElement = term.element;
        if (termElement) {
          termElement.style.transform = "";
          termElement.style.transformOrigin = "";
        }
        container.style.overflowX = "hidden";
        container.style.overflowY = "hidden";
      };

      const proposeHardGridDimensions = (): { cols: number; rows: number } | null => {
        if (
          disposed
          || !usesHardGrid()
          || container.clientWidth <= 0
          || container.clientHeight <= 0
        ) {
          return null;
        }
        const proposeDimensions = (fitAddon as {
          proposeDimensions?: () => { cols: number; rows: number } | undefined;
        }).proposeDimensions;
        if (typeof proposeDimensions !== "function") {
          return null;
        }
        let proposed: { cols: number; rows: number } | undefined;
        try {
          proposed = proposeDimensions.call(fitAddon);
        } catch (err: unknown) {
          log("dimension-proposal-failed", {
            message: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
        if (
          !proposed
          || !Number.isFinite(proposed.cols)
          || !Number.isFinite(proposed.rows)
          || proposed.cols <= 0
          || proposed.rows <= 0
        ) {
          return null;
        }
        return {
          cols: Math.min(TERMINAL_CANONICAL_MAX_COLS, Math.floor(proposed.cols)),
          rows: Math.min(TERMINAL_CANONICAL_MAX_ROWS, Math.floor(proposed.rows)),
        };
      };

      const rememberHardGridDeclaration = (size: { cols: number; rows: number }): boolean => {
        if (
          lastDeclaredHardSize?.cols === size.cols
          && lastDeclaredHardSize.rows === size.rows
        ) {
          return false;
        }
        lastDeclaredHardSize = size;
        return true;
      };

      const measureAndDeclareHardGrid = () => {
        const proposed = proposeHardGridDimensions();
        if (!proposed) {
          return;
        }
        const ws = wsRef.current;
        if (ws?.readyState !== WebSocket.OPEN) {
          if (!ws || ws.readyState === WebSocket.CLOSED) {
            connectWs();
          }
          return;
        }
        if (!allowRemoteResizeRef.current || !rememberHardGridDeclaration(proposed)) {
          return;
        }
        ws.send(JSON.stringify({ type: "resize", ...proposed }));
      };

      const scheduleHardGridMeasurement = () => {
        if (disposed || hardGridMeasureFrame !== null || !usesHardGrid()) {
          return;
        }
        hardGridMeasureFrame = requestAnimationFrame(() => {
          hardGridMeasureFrame = null;
          measureAndDeclareHardGrid();
        });
      };

      const applyCanonicalGridSize = (size: { cols: number; rows: number }) => {
        if (!usesCanonicalGrid()) {
          return;
        }
        if (usesHardGrid()) {
          clearSoftGridLayout();
        }
        if (term.cols !== size.cols || term.rows !== size.rows) {
          term.resize(size.cols, size.rows);
        }
        if (usesSoftGrid()) {
          scheduleSoftGridLayout();
        }
      };

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
          if (usesCanonicalGrid()) {
            if (usesSoftGrid()) {
              scheduleSoftGridLayout();
            } else {
              clearSoftGridLayout();
              scheduleHardGridMeasurement();
            }
            focusIfAllowed();
            return;
          }
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
          applyXtermScrollSurface(termElement, xtermTheme.background);
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
        let restoredFitSucceeded = true;
        if (usesCanonicalGrid()) {
          if (usesSoftGrid()) {
            scheduleSoftGridLayout();
          } else {
            clearSoftGridLayout();
            scheduleHardGridMeasurement();
          }
        } else {
          try {
            fitAddon.fit();
            sendTerminalResize(wsRef.current, term, allowRemoteResizeRef.current);
          } catch (err: unknown) {
            restoredFitSucceeded = false;
            log("fit-failed", { message: err instanceof Error ? err.message : String(err) });
          }
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
          rightClickSelectsWord: false,
          allowProposedApi: true,
          logger: createXtermLogger(),
          fontSize: terminalFontSize,
          fontFamily: buildTerminalFontStack(terminalFontFamily, theme.fonts?.mono),
          minimumContrastRatio: getTerminalMinimumContrastRatio(xtermTheme),
          theme: xtermTheme,
          linkHandler: { activate: activateTerminalLink },
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
          applyXtermScrollSurface(xtermElement, xtermTheme.background);
          xtermElement.style.fontVariantLigatures = terminalLigatures ? "normal" : "none";
        }
        if (!usesCanonicalGrid()) {
          nextFitAddon.fit();
        }

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

      softGridLayoutRef.current = scheduleSoftGridLayout;
      hardGridMeasureRef.current = scheduleHardGridMeasurement;

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
        options: {
          alreadyAttached?: boolean;
          generation?: number;
          replayRequest?: CanonicalReplayRequest;
        } = {},
      ) {
        const generation = options.generation ?? wsGenerationRef.current + 1;
        wsGenerationRef.current = generation;
        wsRef.current = ws;
        const alreadyAttached = options.alreadyAttached === true;
        const isColdReplay = options.replayRequest?.mode === "cold-replay";
        const isCurrentWs = () => (
          wsRef.current === ws
          && wsGenerationRef.current === generation
          && !disposed
          && !isClosingRef.current
        );
        coldReplayVisibility?.dispose();
        const replayVisibility = createColdReplayVisibility({
          terminal: term,
          coldReplay: isColdReplay,
          isCurrent: isCurrentWs,
          onVisible: () => track("cold-replay-visible", {
            requestedSeq: options.replayRequest?.requestedSeq,
          }),
          onTimeout: () => {
            log("cold-replay-timeout");
            track("cold-replay-timeout", { requestedSeq: options.replayRequest?.requestedSeq });
            lastSeqRef.current = 0;
            hasReplayCursorRef.current = false;
            term.reset();
            setConnectionNotice("reconnecting");
            ws.close();
          },
        });
        coldReplayVisibility = replayVisibility;
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
            pingIntervalMs: 10_000,
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
          if (usesHardGrid()) {
            scheduleHardGridMeasurement();
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
          replayVisibility.dispose();
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
          if (leaseWasRevoked) return;

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
                replayMode: options.replayRequest?.mode,
                requestedSeq: options.replayRequest?.requestedSeq,
                acceptedSeq: msg.fromSeq,
              });
              track("attached", {
                state: msg.state,
                hasExitCode: msg.exitCode != null,
                replayMode: options.replayRequest?.mode,
                requestedSeq: options.replayRequest?.requestedSeq,
                acceptedSeq: msg.fromSeq ?? undefined,
              });
              sessionIdRef.current = msg.sessionId;
              if (msg.canonicalSize) {
                applyCanonicalGridSize(msg.canonicalSize);
              }
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

            case "canonical-size":
              applyCanonicalGridSize(msg);
              break;

            case "lease-revoked":
              leaseWasRevoked = true;
              setConnectionNotice("elsewhere");
              ws.close();
              break;

            case "presentation-reset":
              term.reset();
              outputBufferRef.current = "";
              commandBlockBufferRef.current = "";
              activeCommandBlockRef.current = false;
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
              if (mayContainTerminalLink(outputBufferRef.current)) {
                clearLinkDetectTimer();
                linkDetectTimerRef.current = setTimeout(() => {
                  linkDetectTimerRef.current = null;
                  if (disposed) {
                    outputBufferRef.current = "";
                    return;
                  }
                  const scan = scanTerminalLinkOutput(outputBufferRef.current);
                  outputBufferRef.current = scan.bufferedOutput;
                  if (scan.entries.length > 0) {
                    dispatchTerminalLinks({ type: "linksDetected", entries: scan.entries });
                  }
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
              clearLinkDetectTimer();
              outputBufferRef.current = "";
              break;
            case "replay-end":
              replayVisibility.revealAfterWrites();
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
              replayVisibility.revealAfterWrites();
              break;
            }
          }
        };

        if (!attachOnOpen && ws.readyState === WebSocket.OPEN) {
          if (alreadyAttached) {
            if (usesCanonicalGrid()) {
              if (usesSoftGrid()) {
                scheduleSoftGridLayout();
              } else {
                clearSoftGridLayout();
                scheduleHardGridMeasurement();
              }
            } else {
              sendTerminalResize(ws, term, allowRemoteResizeRef.current);
            }
            return;
          }
          sendAttach();
        }
      }

      function getCanonicalReplayRequest(): CanonicalReplayRequest | undefined {
        const currentSessionId = sessionIdRef.current;
        return currentSessionId && isCanonicalShellSessionId(currentSessionId)
          ? {
              mode: hasReplayCursorRef.current ? "cursor-resume" : "cold-replay",
              requestedSeq: hasReplayCursorRef.current ? lastSeqRef.current : 0,
            }
          : undefined;
      }

      function connectWs() {
        if (
          disposed
          || isClosingRef.current
          || webSocketConnectPending
          || wsRef.current?.readyState === WebSocket.CONNECTING
          || wsRef.current?.readyState === WebSocket.OPEN
        ) {
          return;
        }
        const currentSessionId = sessionIdRef.current;
        const wsPath = terminalWebSocketPathForSession(currentSessionId);
        const replayRequest = getCanonicalReplayRequest();
        const declaredSize = usesHardGrid() ? proposeHardGridDimensions() : null;
        // A hard declaration without dimensions is intentionally downgraded to
        // legacy by the gateway. Wait for a real measurement so a hidden pane
        // can never join as either a legacy client or a destructive 1x1 grid.
        if (usesHardGrid() && !declaredSize) {
          return;
        }
        if (declaredSize) {
          rememberHardGridDeclaration(declaredSize);
        }
        webSocketConnectPending = true;
        const generation = wsGenerationRef.current + 1;
        wsGenerationRef.current = generation;
        const query = currentSessionId && isCanonicalShellSessionId(currentSessionId)
          ? {
              session: currentSessionId,
              fromSeq: String(replayRequest?.requestedSeq ?? 0),
              client: suppressNativeKeyboard ? "soft" : "hard",
              ...(isFocusedRef.current ? { lease: "exclusive" } : {}),
              ...(declaredSize
                ? { cols: String(declaredSize.cols), rows: String(declaredSize.rows) }
                : {}),
            }
          : currentSessionId || !cwd
            ? undefined
            : { cwd };
        const queryCwd = query && "cwd" in query ? query.cwd : null;
        const querySession = query && "session" in query ? query.session : null;
        log("connect-ws", {
          wsPath,
          queryCwd,
          querySession,
          replayMode: replayRequest?.mode,
          requestedSeq: replayRequest?.requestedSeq,
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
            if (generation === wsGenerationRef.current) {
              webSocketConnectPending = false;
            }
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
            bindWs(ws, true, { generation, replayRequest });
          });
      }

      resumeLeaseRef.current = () => {
        if (disposed || isClosingRef.current) return;
        if (webSocketConnectPending) {
          // The pending URL was built with the focus state captured when the
          // request started. Invalidate it before reconnecting so a pane that
          // becomes active mid-request cannot finish as a non-exclusive
          // observer and retain the session's stale canonical grid.
          wsGenerationRef.current += 1;
          webSocketConnectPending = false;
        }
        const existing = wsRef.current;
        if (existing && existing.readyState !== WebSocket.CLOSED) {
          existing.onopen = null;
          existing.onclose = null;
          existing.onerror = null;
          existing.onmessage = null;
          existing.close();
          wsRef.current = null;
          heartbeatRef.current?.stop();
        }
        leaseWasRevoked = false;
        reconnectAttemptRef.current = 0;
        setConnectionNotice(null);
        connectWs();
      };

      if (cached && canReuseCachedSocket) {
        bindWs(cached.ws, cached.ws.readyState === WebSocket.CONNECTING, {
          alreadyAttached: cached.ws.readyState === WebSocket.OPEN,
          replayRequest: getCanonicalReplayRequest(),
        });
      } else {
        if (cached) {
          if (canReuseCachedTerminal) {
            closeStaleCachedSocket(cached);
          } else {
            discardStaleCachedTerminal(cached);
          }
          if (wsRef.current === cached.ws) {
            wsRef.current = null;
          }
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

      const onLinkContextMenu = (event: MouseEvent) => {
        const cell = terminalCellFromPointer(term, event.clientX, event.clientY);
        const link = cell ? findTerminalLinkAtCell(term, cell) : null;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setLinkContextMenu({
          x: event.clientX,
          y: event.clientY,
          link,
          selection: term.getSelection(),
        });
      };
      container.addEventListener("contextmenu", onLinkContextMenu, true);

      onDataDisposableRef.current?.dispose();
      onDataDisposableRef.current = term.onData((data: string) => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data }));
        }
      });

      onResizeDisposableRef.current?.dispose();
      onResizeDisposableRef.current = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        if (usesCanonicalGrid()) {
          if (usesSoftGrid()) {
            scheduleSoftGridLayout();
          }
          return;
        }
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

        const clipboardAction = classifyTerminalClipboardShortcut({
          type: ev.type as "keydown" | "keyup" | "keypress",
          key: ev.key,
          isMac: isAppleCommandPlatform(navigator.platform),
          metaKey: ev.metaKey,
          ctrlKey: ev.ctrlKey,
          shiftKey: ev.shiftKey,
          altKey: ev.altKey,
          repeat: ev.repeat,
          isComposing: ev.isComposing,
          hasSelection: term.getSelection().length > 0,
        });
        if (clipboardAction === "copy") {
          ev.preventDefault();
          const selection = term.getSelection();
          void navigator.clipboard?.writeText(selection).catch((error: unknown) => {
            console.warn("[terminal] clipboard copy unavailable", {
              category: error instanceof DOMException ? error.name : "clipboard-error",
            });
            showPasteError("Clipboard copy failed. Try again.");
          });
          return false;
        }
        if (clipboardAction === "paste") {
          ev.preventDefault();
          void pasteClipboardIntoTerminal({
            clipboard: typeof navigator !== "undefined" ? navigator.clipboard : undefined,
            gatewayUrl: getGatewayUrl(),
            ws: wsRef.current,
          }).then((result) => {
            if (result === "failed" || result === "unavailable") {
              showPasteError("Clipboard paste failed. Try again or paste a saved file with `mos shell paste-file`.");
            }
          }).catch((error: unknown) => {
            console.warn("[terminal] clipboard paste unavailable", {
              category: error instanceof DOMException ? error.name : "clipboard-error",
            });
            showPasteError("Clipboard paste failed. Try again or paste a saved file with `mos shell paste-file`.");
          });
          return false;
        }
        if (clipboardAction === "select-all") {
          ev.preventDefault();
          term.selectAll();
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

      // react-doctor-disable-next-line react-doctor/effect-observer-needs-disconnect -- the async init lifecycle returns a cleanup below that disconnects this observer before terminal teardown.
      const resizeObserver = new ResizeObserver(() => {
        if (usesCanonicalGrid()) {
          if (usesSoftGrid()) {
            scheduleSoftGridLayout();
          } else {
            scheduleHardGridMeasurement();
          }
        } else {
          requestAnimationFrame(refitOnly);
        }
      });
      resizeObserver.observe(container);
      const fontSet = document.fonts;
      const onFontMetricsChange = () => requestAnimationFrame(refitOnly);
      fontSet?.addEventListener("loadingdone", onFontMetricsChange);
      void fontSet?.ready.then(() => {
        if (!disposed) {
          onFontMetricsChange();
        }
      });

      return () => {
        document.removeEventListener("visibilitychange", onVisibilityChange);
        container.removeEventListener("contextmenu", onLinkContextMenu, true);
        fontSet?.removeEventListener("loadingdone", onFontMetricsChange);
        resizeObserver.disconnect();
        if (softGridLayoutFrame !== null) {
          cancelAnimationFrame(softGridLayoutFrame);
          softGridLayoutFrame = null;
        }
        if (hardGridMeasureFrame !== null) {
          cancelAnimationFrame(hardGridMeasureFrame);
          hardGridMeasureFrame = null;
        }
        if (softGridLayoutRef.current === scheduleSoftGridLayout) {
          softGridLayoutRef.current = null;
        }
        if (hardGridMeasureRef.current === scheduleHardGridMeasurement) {
          hardGridMeasureRef.current = null;
        }
        softGridScaleRef.current = 1;
        clearLinkDetectTimer();
        clearReconnectTimer();
        clearPendingReconnectBanner();
        coldReplayVisibility?.dispose();
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
      applyXtermSurfaceBackground(
        (termRef.current as { element?: HTMLElement }).element,
        xtermTheme.background,
      );
      applyTerminalAppearance(
        termRef.current as Parameters<typeof applyTerminalAppearance>[0],
        fitAddonRef.current as Parameters<typeof applyTerminalAppearance>[1],
        {
          theme: xtermTheme,
          minimumContrastRatio: getTerminalMinimumContrastRatio(xtermTheme),
          fontFamily: buildTerminalFontStack(terminalFontFamily, theme.fonts?.mono),
          fontSize: terminalFontSize,
          cursorBlink,
          cursorStyle: terminalCursorStyle,
          smoothScrollDuration: terminalSmoothScroll ? 125 : 0,
          ligatures: terminalLigatures,
          fit: !Boolean(sessionIdRef.current && isCanonicalShellSessionId(sessionIdRef.current)),
        },
      );
      softGridLayoutRef.current?.();
      hardGridMeasureRef.current?.();
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

  useTerminalFocusRequest(termRef, focusRequestId, isFocused, suppressNativeKeyboard);

  useEffect(() => {
    const becameFocused = isFocused && !wasFocusedRef.current;
    wasFocusedRef.current = isFocused;
    if (becameFocused) resumeLeaseRef.current();
  }, [isFocused]);

  // Re-fit the terminal whenever the visual viewport changes (soft keyboard
  // open/close, URL-bar collapse, orientation). The document viewport is
  // resized by `interactiveWidget: "resizes-content"`; the terminal host does
  // not subtract a keyboard CSS var, so these passes only recompute rows/cols
  // and keep the prompt visible after mobile keyboard transitions settle.
  useEffect(() => {
    const currentSessionId = sessionIdRef.current;
    if (currentSessionId && isCanonicalShellSessionId(currentSessionId)) {
      const id = requestAnimationFrame(() => {
        if (suppressNativeKeyboard) {
          softGridLayoutRef.current?.();
        } else {
          hardGridMeasureRef.current?.();
        }
      });
      return () => cancelAnimationFrame(id);
    }
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
        backgroundColor: terminalSurfaceBackground,
      }}
      onPointerDown={handleFocus}
      onClick={handleFocus}
    >
      {pasteError && (
        <div
          role="status"
          aria-live="polite"
          style={{
            ...TERMINAL_OVERLAY_BASE_STYLE,
            top: terminalLinks.presentation === "expanded" ? 76 : 8,
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
            ...TERMINAL_OVERLAY_BASE_STYLE,
            top: terminalLinks.presentation === "expanded" ? 76 : 8,
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
          {connectionNotice === "reconnecting"
            ? "Reconnecting terminal..."
            : connectionNotice === "elsewhere"
              ? <><span>Live on another device.</span><button type="button" onClick={() => resumeLeaseRef.current()}>Resume here</button></>
              : "Terminal disconnected"}
        </div>
      )}
      <TerminalLinksTray
        state={terminalLinks}
        onCollapse={collapseTerminalLinks}
        onDismiss={dismissTerminalLinks}
        onOpen={openTerminalLink}
        onCopy={copyTerminalLink}
      />
      <TerminalLinkContextMenu
        menu={linkContextMenu}
        onClose={closeLinkContextMenu}
        onOpen={openTerminalLink}
        onCopy={copyTerminalLink}
        onCopySelection={copyTerminalSelection}
        onSelectAll={selectAllTerminal}
      />
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
