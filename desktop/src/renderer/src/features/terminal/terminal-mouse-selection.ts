const DEFAULT_DRAG_THRESHOLD_PX = 4;
const EDGE_SCROLL_INTERVAL_MS = 40;
const EDGE_SCROLL_DISTANCE_PER_LINE_PX = 24;
const MAX_EDGE_SCROLL_LINES = 6;
const MAX_EXTENDED_SELECTION_LINES = 5_000;

type MouseTrackingMode = "none" | string;

interface MouseTrackingTerminal {
  readonly modes: { mouseTrackingMode: MouseTrackingMode };
  readonly element?: HTMLElement;
  readonly cols: number;
  readonly rows: number;
  readonly buffer: {
    readonly active: {
      readonly viewportY: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
  selectLines(start: number, end: number): void;
  scrollLines(amount: number): void;
}

interface InstallMouseTrackingSelectionOptions {
  host: HTMLElement;
  getTerminal: () => MouseTrackingTerminal | null;
  getVisualScale: () => number;
  isMac: boolean;
  onPrimaryGestureStart: () => void;
  onExtendedSelection?: (selection: string) => void;
  dragThresholdPx?: number;
}

interface MouseSnapshot {
  target: EventTarget;
  clientX: number;
  clientY: number;
  screenX: number;
  screenY: number;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  detail: number;
}

interface PendingGesture {
  start: MouseSnapshot;
  dragging: boolean;
  forceSelection: boolean;
  appOwnsSelection: boolean;
}

type MatrixSyntheticMouseEvent = MouseEvent & { _xtermScaleCorrected?: boolean };

export interface TerminalEdgeSelectionSlice {
  startRow: number;
  lines: string[];
}

export function mergeTerminalEdgeSelectionLines(
  current: TerminalEdgeSelectionSlice,
  next: TerminalEdgeSelectionSlice,
  direction: "up" | "down",
): TerminalEdgeSelectionSlice {
  const cap = (slice: TerminalEdgeSelectionSlice): TerminalEdgeSelectionSlice => {
    if (slice.lines.length <= MAX_EXTENDED_SELECTION_LINES) return slice;
    if (direction === "down") {
      return { ...slice, lines: slice.lines.slice(0, MAX_EXTENDED_SELECTION_LINES) };
    }
    const removed = slice.lines.length - MAX_EXTENDED_SELECTION_LINES;
    return {
      startRow: slice.startRow + removed,
      lines: slice.lines.slice(-MAX_EXTENDED_SELECTION_LINES),
    };
  };
  if (current.lines.length === 0) return cap(next);
  if (next.lines.length === 0) return cap(current);
  if (direction === "up") {
    const freshCount = Math.min(
      next.lines.length,
      Math.max(0, current.startRow - next.startRow),
    );
    if (freshCount === 0) return cap(current);
    return cap({
      startRow: next.startRow,
      lines: [...next.lines.slice(0, freshCount), ...current.lines],
    });
  }
  const currentEndRow = current.startRow + current.lines.length;
  const freshStart = Math.min(
    next.lines.length,
    Math.max(0, currentEndRow - next.startRow),
  );
  if (freshStart >= next.lines.length) return cap(current);
  return cap({
    startRow: current.startRow,
    lines: [...current.lines, ...next.lines.slice(freshStart)],
  });
}

function snapshot(event: MouseEvent): MouseSnapshot {
  return {
    target: event.target ?? event.currentTarget ?? event.view ?? globalThis,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    detail: event.detail,
  };
}

function stopOriginal(event: MouseEvent): void {
  event.preventDefault();
  event.stopImmediatePropagation();
}

export function installMouseTrackingSelection({
  host,
  getTerminal,
  getVisualScale,
  isMac,
  onPrimaryGestureStart,
  onExtendedSelection,
  dragThresholdPx = DEFAULT_DRAG_THRESHOLD_PX,
}: InstallMouseTrackingSelectionOptions): () => void {
  const document = host.ownerDocument;
  let gesture: PendingGesture | null = null;
  let edgePointer: MouseSnapshot | null = null;
  let edgeScrollTimer: number | null = null;
  let extendedSelectionLines: TerminalEdgeSelectionSlice | null = null;
  let edgeDirection: "up" | "down" | null = null;
  let edgeAnchorColumn: number | null = null;

  const dispatch = (
    source: MouseSnapshot,
    type: "mousedown" | "mousemove" | "mouseup",
    button: number,
    buttons: number,
    forceSelection: boolean,
  ) => {
    const terminal = getTerminal();
    const coordinateElement = terminal?.element ?? host;
    const rect = coordinateElement.getBoundingClientRect();
    const rawScale = getVisualScale();
    const scale = Number.isFinite(rawScale) && rawScale > 0 ? rawScale : 1;
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      detail: source.detail,
      screenX: source.screenX,
      screenY: source.screenY,
      clientX: rect.left + (source.clientX - rect.left) / scale,
      clientY: rect.top + (source.clientY - rect.top) / scale,
      ctrlKey: source.ctrlKey,
      altKey: forceSelection && isMac ? true : source.altKey,
      shiftKey: forceSelection && !isMac ? true : source.shiftKey,
      metaKey: source.metaKey,
      button,
      buttons,
    });
    Object.defineProperty(event, "_xtermScaleCorrected", { value: true });
    source.target.dispatchEvent(event);
  };

  const removeDocumentListeners = () => {
    document.removeEventListener("mousemove", onDocumentMouseMove, true);
    document.removeEventListener("mouseup", onDocumentMouseUp, true);
    document.defaultView?.removeEventListener("blur", cancelGesture);
  };

  const stopEdgeScroll = () => {
    edgePointer = null;
    if (edgeScrollTimer !== null) {
      document.defaultView?.clearInterval(edgeScrollTimer);
      edgeScrollTimer = null;
    }
  };

  const selectionTarget = (source: MouseSnapshot): MouseSnapshot => (
    gesture ? { ...source, target: gesture.start.target } : source
  );

  const edgeScrollAmount = (source: MouseSnapshot): number => {
    const terminal = getTerminal();
    const coordinateElement = terminal?.element ?? host;
    const rect = coordinateElement.getBoundingClientRect();
    const distance = source.clientY < rect.top
      ? source.clientY - rect.top
      : source.clientY > rect.bottom
        ? source.clientY - rect.bottom
        : 0;
    if (distance === 0) return 0;
    const magnitude = Math.min(
      MAX_EDGE_SCROLL_LINES,
      Math.max(1, Math.ceil(Math.abs(distance) / EDGE_SCROLL_DISTANCE_PER_LINE_PX)),
    );
    return distance < 0 ? -magnitude : magnitude;
  };

  const dispatchEdgeWheel = (source: MouseSnapshot, amount: number) => {
    const terminal = getTerminal();
    const coordinateElement = terminal?.element ?? host;
    const rect = coordinateElement.getBoundingClientRect();
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: Math.min(rect.right - 1, Math.max(rect.left + 1, source.clientX)),
      clientY: amount < 0 ? rect.top + 1 : rect.bottom - 1,
      deltaY: amount * EDGE_SCROLL_DISTANCE_PER_LINE_PX,
    });
    source.target.dispatchEvent(event);
  };

  const visibleLines = (terminal: MouseTrackingTerminal): TerminalEdgeSelectionSlice => {
    const { active } = terminal.buffer;
    return {
      startRow: active.viewportY,
      lines: Array.from({ length: terminal.rows }, (_, row) => (
        active.getLine(active.viewportY + row)?.translateToString(true) ?? ""
      )),
    };
  };

  const cellAtPointer = (terminal: MouseTrackingTerminal, source: MouseSnapshot) => {
    const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen")
      ?? terminal.element
      ?? host;
    const rect = screen.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return { column: 0, row: 0 };
    return {
      column: Math.min(
        terminal.cols - 1,
        Math.max(0, Math.floor(((source.clientX - rect.left) / rect.width) * terminal.cols)),
      ),
      row: Math.min(
        terminal.rows - 1,
        Math.max(0, Math.floor(((source.clientY - rect.top) / rect.height) * terminal.rows)),
      ),
    };
  };

  const captureExtendedSelection = (terminal: MouseTrackingTerminal, amount: number) => {
    const direction = amount < 0 ? "up" : "down";
    const lines = visibleLines(terminal);
    if (!extendedSelectionLines || edgeDirection !== direction) {
      const anchor = gesture ? cellAtPointer(terminal, gesture.start) : { column: 0, row: 0 };
      extendedSelectionLines = direction === "up"
        ? { startRow: lines.startRow, lines: lines.lines.slice(0, anchor.row + 1) }
        : {
            startRow: lines.startRow + anchor.row,
            lines: lines.lines.slice(anchor.row),
          };
      edgeDirection = direction;
      edgeAnchorColumn = anchor.column;
    } else {
      extendedSelectionLines = mergeTerminalEdgeSelectionLines(
        extendedSelectionLines,
        lines,
        direction,
      );
    }
    const selectedLines = extendedSelectionLines.lines.map((line) => line.trimEnd());
    if (edgeAnchorColumn !== null && selectedLines.length > 0) {
      const anchorIndex = direction === "up" ? selectedLines.length - 1 : 0;
      const anchorLine = selectedLines[anchorIndex] ?? "";
      selectedLines[anchorIndex] = direction === "up"
        ? anchorLine.slice(0, edgeAnchorColumn + 1)
        : anchorLine.slice(edgeAnchorColumn);
    }
    const selection = selectedLines.join("\n").replace(/\n+$/, "");
    if (selection) onExtendedSelection?.(selection);
  };

  const tickEdgeScroll = () => {
    if (!gesture?.dragging || !edgePointer) {
      stopEdgeScroll();
      return;
    }
    const amount = edgeScrollAmount(edgePointer);
    if (amount === 0) {
      stopEdgeScroll();
      return;
    }
    const terminal = getTerminal();
    if (gesture.appOwnsSelection) {
      if (terminal) captureExtendedSelection(terminal, amount);
      dispatchEdgeWheel(edgePointer, amount);
      terminal?.scrollLines(amount);
    } else {
      terminal?.scrollLines(amount);
    }
    dispatch(
      selectionTarget(edgePointer),
      "mousemove",
      0,
      1,
      gesture.forceSelection,
    );
    if (terminal && gesture.appOwnsSelection) {
      terminal.selectLines(terminal.buffer.active.viewportY, terminal.buffer.active.viewportY + terminal.rows - 1);
    }
  };

  const updateEdgeScroll = (source: MouseSnapshot) => {
    if (edgeScrollAmount(source) === 0) {
      stopEdgeScroll();
      return;
    }
    edgePointer = selectionTarget(source);
    if (edgeScrollTimer === null) {
      edgeScrollTimer = document.defaultView?.setInterval(
        tickEdgeScroll,
        EDGE_SCROLL_INTERVAL_MS,
      ) ?? null;
    }
  };

  const cancelGesture = () => {
    stopEdgeScroll();
    gesture = null;
    extendedSelectionLines = null;
    edgeDirection = null;
    edgeAnchorColumn = null;
    removeDocumentListeners();
  };

  const onDocumentMouseMove = (event: MouseEvent) => {
    if ((event as MatrixSyntheticMouseEvent)._xtermScaleCorrected || !gesture) return;
    if (gesture.forceSelection) stopOriginal(event);
    const current = snapshot(event);
    if (!gesture.dragging) {
      const distance = Math.hypot(
        current.clientX - gesture.start.clientX,
        current.clientY - gesture.start.clientY,
      );
      if (distance < dragThresholdPx) return;
      gesture.dragging = true;
      if (gesture.forceSelection) {
        dispatch(gesture.start, "mousedown", 0, 1, true);
      }
    }
    const targetedCurrent = selectionTarget(current);
    if (gesture.forceSelection || !event.composedPath().includes(host)) {
      dispatch(targetedCurrent, "mousemove", 0, 1, gesture.forceSelection);
    }
    updateEdgeScroll(targetedCurrent);
  };

  const onDocumentMouseUp = (event: MouseEvent) => {
    if ((event as MatrixSyntheticMouseEvent)._xtermScaleCorrected || !gesture) return;
    if (gesture.forceSelection) stopOriginal(event);
    const current = selectionTarget(snapshot(event));
    const amount = edgePointer ? edgeScrollAmount(edgePointer) : 0;
    const terminal = getTerminal();
    if (amount !== 0 && terminal && gesture.appOwnsSelection) {
      captureExtendedSelection(terminal, amount);
    }
    if (gesture.dragging) {
      if (gesture.forceSelection || !event.composedPath().includes(host)) {
        dispatch(current, "mouseup", 0, 0, gesture.forceSelection);
      }
    } else if (gesture.forceSelection) {
      const forceSelection = gesture.start.detail >= 2;
      dispatch(gesture.start, "mousedown", 0, 1, forceSelection);
      dispatch(current, "mouseup", 0, 0, forceSelection);
    }
    cancelGesture();
  };

  const onMouseDown = (event: MouseEvent) => {
    if ((event as MatrixSyntheticMouseEvent)._xtermScaleCorrected || event.button !== 0) return;
    const terminal = getTerminal();
    if (!terminal) return;
    cancelGesture();
    const appOwnsSelection = terminal.modes.mouseTrackingMode !== "none";
    const forceSelection = appOwnsSelection;
    gesture = { start: snapshot(event), dragging: false, forceSelection, appOwnsSelection };
    if (forceSelection) {
      onPrimaryGestureStart();
      stopOriginal(event);
    }
    document.addEventListener("mousemove", onDocumentMouseMove, true);
    document.addEventListener("mouseup", onDocumentMouseUp, true);
    document.defaultView?.addEventListener("blur", cancelGesture, { once: true });
  };

  host.addEventListener("mousedown", onMouseDown, true);
  return () => {
    host.removeEventListener("mousedown", onMouseDown, true);
    cancelGesture();
  };
}
