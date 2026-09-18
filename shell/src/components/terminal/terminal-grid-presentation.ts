import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { createTerminalGridPresentation, measureTerminalGridDimensions } from "@matrix-os/ui";
import { isCanonicalShellSessionId } from "./terminal-session-id";
import { sendTerminalResize } from "./terminal-remote-resize";
import { TERMINAL_CANONICAL_MAX_COLS, TERMINAL_CANONICAL_MAX_ROWS } from "./terminal-xterm-runtime";

export function createWebTerminalGridPresentation({
  container, getTerm, getFitAddon, getSessionId, getSocket, getFontSize,
  isDisposed, allowRemoteResize, hasWriteOwnership, suppressNativeKeyboard, connectWs, onScale, getParentScale, log,
}: {
  container: HTMLElement;
  getTerm: () => Terminal;
  getFitAddon: () => FitAddon;
  getSessionId: () => string | null | undefined;
  getSocket: () => WebSocket | null;
  getFontSize: () => number;
  isDisposed: () => boolean;
  allowRemoteResize: () => boolean;
  hasWriteOwnership: () => boolean;
  suppressNativeKeyboard: boolean;
  connectWs: () => void;
  onScale: (scale: number) => void;
  getParentScale: () => number;
  log: (event: string, details: Record<string, unknown>) => void;
}) {
  let viewportMeasureFrame: number | null = null;
  let lastDeclaredSize: { cols: number; rows: number } | null = null;
  const usesCanonicalGrid = () => {
    const currentSessionId = getSessionId();
    return Boolean(currentSessionId && isCanonicalShellSessionId(currentSessionId));
  };
  const declaresViewportSize = () => usesCanonicalGrid() && !suppressNativeKeyboard;

  const presentation = createTerminalGridPresentation({
    host: container,
    getTerminal: getTerm,
    getConfiguredFontSize: getFontSize,
    enabled: usesCanonicalGrid,
    allowScaling: () => suppressNativeKeyboard || !allowRemoteResize() || !hasWriteOwnership(),
    onScale,
    getParentScale,
  });
  const scheduleSoftGridLayout = () => {
    presentation.schedule();
    scheduleViewportMeasurement();
  };

  const proposeViewportDimensions = (): { cols: number; rows: number } | null => {
    if (
      isDisposed()
      || !declaresViewportSize()
      || container.clientWidth <= 0
      || container.clientHeight <= 0
    ) {
      return null;
    }
    const proposeDimensions = (getFitAddon() as {
      proposeDimensions?: () => { cols: number; rows: number } | undefined;
    }).proposeDimensions;
    if (typeof proposeDimensions !== "function") {
      return null;
    }
    let proposed: { cols: number; rows: number } | undefined;
    try {
      proposed = measureTerminalGridDimensions(container, getTerm(), getFontSize(), () => proposeDimensions.call(getFitAddon()));
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

  const rememberViewportDeclaration = (size: { cols: number; rows: number }): boolean => {
    if (
      lastDeclaredSize?.cols === size.cols
      && lastDeclaredSize.rows === size.rows
    ) {
      return false;
    }
    lastDeclaredSize = size;
    return true;
  };

  const measureAndDeclareViewport = () => {
    const proposed = proposeViewportDimensions();
    if (!proposed) {
      return;
    }
    const ws = getSocket();
    if (ws?.readyState !== WebSocket.OPEN) {
      if (!ws || ws.readyState === WebSocket.CLOSED) {
        connectWs();
      }
      return;
    }
    if (!allowRemoteResize() || !hasWriteOwnership() || !rememberViewportDeclaration(proposed)) {
      return;
    }
    sendTerminalResize(ws, proposed, true, getSessionId(), "hard");
  };

  const scheduleViewportMeasurement = () => {
    if (isDisposed() || viewportMeasureFrame !== null || !declaresViewportSize()) {
      return;
    }
    viewportMeasureFrame = requestAnimationFrame(() => {
      viewportMeasureFrame = null;
      measureAndDeclareViewport();
    });
  };

  const applyCanonicalGridSize = (size: { cols: number; rows: number }) => {
    if (!usesCanonicalGrid()) {
      return;
    }
    if (getTerm().cols !== size.cols || getTerm().rows !== size.rows) {
      getTerm().resize(size.cols, size.rows);
    }
    scheduleSoftGridLayout();
  };

  return {
    usesCanonicalGrid, declaresViewportSize,
    proposeViewportDimensions, rememberViewportDeclaration,
    scheduleSoftGridLayout, scheduleViewportMeasurement,
    applyCanonicalGridSize,
    resetViewportDeclaration() { lastDeclaredSize = null; },
    dispose() {
      presentation.dispose();
      if (viewportMeasureFrame !== null) cancelAnimationFrame(viewportMeasureFrame);
    },
  };
}
