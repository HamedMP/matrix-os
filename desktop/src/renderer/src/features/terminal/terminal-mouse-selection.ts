const DEFAULT_DRAG_THRESHOLD_PX = 4;

type MouseTrackingMode = "none" | string;

interface MouseTrackingTerminal {
  readonly modes: { mouseTrackingMode: MouseTrackingMode };
  readonly element?: HTMLElement;
}

interface InstallMouseTrackingSelectionOptions {
  host: HTMLElement;
  getTerminal: () => MouseTrackingTerminal | null;
  getVisualScale: () => number;
  isMac: boolean;
  onPrimaryGestureStart: () => void;
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
}

type MatrixSyntheticMouseEvent = MouseEvent & { _xtermScaleCorrected?: boolean };

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
  dragThresholdPx = DEFAULT_DRAG_THRESHOLD_PX,
}: InstallMouseTrackingSelectionOptions): () => void {
  const document = host.ownerDocument;
  let gesture: PendingGesture | null = null;

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

  const cancelGesture = () => {
    gesture = null;
    removeDocumentListeners();
  };

  const onDocumentMouseMove = (event: MouseEvent) => {
    if ((event as MatrixSyntheticMouseEvent)._xtermScaleCorrected || !gesture) return;
    stopOriginal(event);
    const current = snapshot(event);
    if (!gesture.dragging) {
      const distance = Math.hypot(
        current.clientX - gesture.start.clientX,
        current.clientY - gesture.start.clientY,
      );
      if (distance < dragThresholdPx) return;
      gesture.dragging = true;
      dispatch(gesture.start, "mousedown", 0, 1, true);
    }
    dispatch(current, "mousemove", 0, 1, true);
  };

  const onDocumentMouseUp = (event: MouseEvent) => {
    if ((event as MatrixSyntheticMouseEvent)._xtermScaleCorrected || !gesture) return;
    stopOriginal(event);
    const current = snapshot(event);
    if (gesture.dragging) {
      dispatch(current, "mouseup", 0, 0, true);
    } else {
      const forceSelection = gesture.start.detail >= 2;
      dispatch(gesture.start, "mousedown", 0, 1, forceSelection);
      dispatch(current, "mouseup", 0, 0, forceSelection);
    }
    cancelGesture();
  };

  const onMouseDown = (event: MouseEvent) => {
    if ((event as MatrixSyntheticMouseEvent)._xtermScaleCorrected || event.button !== 0) return;
    const terminal = getTerminal();
    if (!terminal || terminal.modes.mouseTrackingMode === "none") return;
    cancelGesture();
    onPrimaryGestureStart();
    gesture = { start: snapshot(event), dragging: false };
    stopOriginal(event);
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
