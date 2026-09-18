import { computeSoftGridLayout } from "./terminal-soft-grid.js";
import { createTerminalScrollbar } from "./terminal-scrollbar.js";
import { terminalContentExtent } from "./terminal-content-extent.js";
import { panTerminalGrid } from "./terminal-grid-wheel.js";

interface GridTerminal {
  element?: HTMLElement | null;
  focus?: () => void;
  cols: number;
  rows: number;
  options: { fontSize?: number; scrollback?: number; overviewRuler?: { width?: number } };
  onWriteParsed?: (listener: () => void) => { dispose(): void };
  onScroll?: (listener: () => void) => { dispose(): void };
  scrollToLine?: (line: number) => void;
  buffer?: { active: { type?: string; baseY: number; viewportY: number; cursorX: number; cursorY: number;
    getLine?: (row: number) => { getCell(column: number): { getChars(): string; getWidth(): number; isBgDefault(): boolean; isInverse?: () => number } | undefined } | undefined;
  } };
}

interface GridPresentationOptions {
  host: HTMLElement;
  getTerminal: () => GridTerminal;
  getConfiguredFontSize: () => number;
  enabled?: () => boolean;
  allowScaling?: () => boolean;
  onScale?: (scale: number) => void;
  getParentScale?: () => number;
}

function pixels(value: string): number {
  return Number.parseFloat(value) || 0;
}

function dimension(element: HTMLElement, axis: "width" | "height"): number {
  return pixels(element.style[axis]) || (axis === "width" ? element.offsetWidth : element.offsetHeight);
}

/** FitAddon reads its parent's box; the presentation stage is not the viewport. */
export function measureTerminalViewport<T>(host: HTMLElement, root: HTMLElement | null | undefined, measure: () => T): T | undefined {
  if (!host.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) return undefined;
  const stage = root?.parentElement;
  if (!stage?.hasAttribute("data-terminal-grid-stage")) return measure();
  const width = stage.style.width;
  const height = stage.style.height;
  const scrollTop = host.scrollTop;
  const scrollLeft = host.scrollLeft;
  const style = getComputedStyle(host);
  try {
    stage.style.width = `${Math.max(0, host.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight))}px`;
    stage.style.height = `${Math.max(0, host.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom))}px`;
    return measure();
  } finally {
    stage.style.width = width;
    stage.style.height = height;
    // Measuring a smaller parent can synchronously clamp its scroll offsets.
    host.scrollTop = scrollTop;
    host.scrollLeft = scrollLeft;
  }
}

/** Measure writable viewport proposals at the configured font, not an observer's fitted font. */
export function measureTerminalGridDimensions<T>(
  host: HTMLElement, terminal: GridTerminal, configuredFontSize: number, measure: () => T,
): T | undefined {
  const previousFontSize = terminal.options.fontSize;
  try {
    if (previousFontSize !== configuredFontSize) terminal.options.fontSize = configuredFontSize;
    return measureTerminalViewport(host, terminal.element, measure);
  } finally {
    if (previousFontSize !== configuredFontSize) terminal.options.fontSize = previousFontSize;
  }
}

/** Local presentation only: never changes the server-owned rows or columns. */
export function createTerminalGridPresentation(options: GridPresentationOptions) {
  const { host } = options;
  let frame: number | null = null;
  let disposed = false;
  let stage: HTMLElement | null = null;
  let element: HTMLElement | null = null;
  let restoreStyle: Partial<CSSStyleDeclaration> | null = null;
  let previousPan: { top: number; left: number } | null = null;
  let wheelPannedAway = false;
  let presentationScale = 1;
  let settledLayout: { metrics: number[]; layout: ReturnType<typeof computeSoftGridLayout> } | null = null;
  let scrollbar: ReturnType<typeof createTerminalScrollbar> | undefined;
  let scrollSubscription: { dispose(): void } | undefined;
  let visualCellHeight = 0;
  let liveContentHeight = 0;
  let contentGrid: { cols: number; rows: number } | undefined;
  let outputSubscription: { dispose(): void } | undefined;

  const onBlankMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.defaultPrevented || !element ||
      (event.target !== host && event.target !== stage)) return;
    options.getTerminal().focus?.();
    // Keep the browser's default focus action from blurring xterm afterward.
    event.preventDefault();
  };

  const onWheel = (event: WheelEvent & { matrixGridCorrected?: boolean }) => {
    if (event.matrixGridCorrected || event.defaultPrevented || !element || !stage || !(event.target instanceof Element) || !host.contains(event.target)) return;
    const scale = presentationScale * (options.getParentScale?.() ?? 1);
    if (!Number.isFinite(scale) || scale <= 0) return;
    const pan = panTerminalGrid(event, host, stage, contentGrid ?? options.getTerminal());
    if (pan.verticalPanned) {
      wheelPannedAway = true;
    }
    if (pan.panned) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (pan.deltaX === 0 && pan.deltaY === 0) return;
    }
    const overTerminal = element.contains(event.target);
    if (scale === 1 && !pan.panned && overTerminal) return;
    const rect = element.getBoundingClientRect();
    // Content clipping must not turn the remaining viewport into a wheel dead
    // zone. Forward its gesture to xterm at a valid canonical-grid coordinate.
    const x = overTerminal ? event.clientX - rect.left : Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left));
    const y = overTerminal ? event.clientY - rect.top : Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top));
    const target = overTerminal ? event.target : element.querySelector(".xterm-screen") ?? element;
    const corrected = new WheelEvent("wheel", {
      bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed,
      clientX: rect.left + x / scale,
      clientY: rect.top + y / scale,
      screenX: event.screenX, screenY: event.screenY,
      deltaX: pan.deltaX, deltaY: pan.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
      button: event.button, buttons: event.buttons,
    });
    Object.defineProperty(corrected, "matrixGridCorrected", { value: true });
    event.stopImmediatePropagation();
    target.dispatchEvent(corrected);
    // Synthetic events have no native scrolling default. Preserve the real
    // event's default unless xterm consumed the corrected wheel report.
    if (corrected.defaultPrevented) event.preventDefault();
  };

  const apply = () => {
    if (disposed || options.enabled?.() === false || host.clientWidth <= 0 || host.clientHeight <= 0) return;
    const terminal = options.getTerminal();
    const root = terminal.element;
    const screen = root?.querySelector<HTMLElement>(".xterm-screen");
    if (!root || !screen) return;
    const width = dimension(screen, "width");
    const height = dimension(screen, "height");
    if (width <= 0 || height <= 0) return;

    const fontSize = terminal.options.fontSize ?? options.getConfiguredFontSize();
    const configured = options.getConfiguredFontSize();
    const style = getComputedStyle(host);
    const viewportWidth = host.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
    const viewportHeight = host.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom);
    if (viewportWidth <= 0 || viewportHeight <= 0) return;
    // xterm reserves this gutter beside its screen for native scrollback.
    const gutter = terminal.scrollToLine && terminal.onScroll ? 0 : terminal.options.scrollback === 0 ? 0 : terminal.options.overviewRuler?.width || 14;
    const allowScaling = options.allowScaling?.() !== false;
    const metrics = [viewportWidth, viewportHeight, width, height, fontSize, configured, gutter, window.devicePixelRatio, Number(allowScaling)];
    // Cell metrics are quantized: extrapolating the configured font from the
    // last fitted font can alternate between two sizes on every output batch.
    // Reuse the fitted result until the viewport, grid, or font metrics change.
    const layout = settledLayout?.metrics.every((value, index) => value === metrics[index])
      ? settledLayout.layout
      : computeSoftGridLayout({
        viewportWidth: allowScaling ? viewportWidth : Math.max(viewportWidth, width * configured / fontSize + gutter),
        viewportHeight: allowScaling ? viewportHeight : Math.max(viewportHeight, height * configured / fontSize),
        gridWidth: width * configured / fontSize + gutter,
        gridHeight: height * configured / fontSize,
        configuredFontSize: configured,
        minimumReadableFontSize: 10,
        devicePixelRatio: window.devicePixelRatio,
      });
    const buffer = terminal.buffer?.active;
    const live = buffer && buffer.viewportY >= buffer.baseY;
    // Resume following at the bottom only when the cursor is already visible.
    // A native redraw with a prompt above the viewport must not undo a pan.
    const cursorTop = buffer && stage ? buffer.cursorY * visualCellHeight : -1;
    if (wheelPannedAway && host.scrollTop >= host.scrollHeight - host.clientHeight - 0.01 && cursorTop >= host.scrollTop) {
      wheelPannedAway = false;
      if (previousPan) previousPan.top = host.scrollTop;
    }
    const followY = live && !wheelPannedAway && (!previousPan || Math.abs(host.scrollTop - previousPan.top) <= 1);

    if (!stage) {
      // xterm emits once per parsed write batch; RAF coalesces output bursts.
      outputSubscription = terminal.onWriteParsed?.(schedule);
      scrollSubscription = terminal.onScroll?.(schedule);
      host.addEventListener("mousedown", onBlankMouseDown);
      host.addEventListener("wheel", onWheel, { capture: true, passive: false });
      element = root;
      restoreStyle = {
        position: root.style.position, width: root.style.width, height: root.style.height,
        top: root.style.top, left: root.style.left,
        transform: root.style.transform, transformOrigin: root.style.transformOrigin,
      };
      stage = document.createElement("div");
      stage.dataset.terminalGridStage = "true";
      // Transforms do not shrink layout overflow. Clip the unscaled box inside
      // a stage whose real dimensions match the visual grid, so pan limits do.
      // Unlike hidden, clip cannot scroll when Chromium reveals xterm's
      // focused textarea; all deliberate panning belongs to the outer host.
      Object.assign(stage.style, { position: "relative", overflow: "clip", flexShrink: "0" });
      root.before(stage);
      stage.append(root);
    }
    if (Math.abs(fontSize - layout.fontSize) > 0.01) terminal.options.fontSize = layout.fontSize;
    // Use measured cell metrics after font changes; glyph metrics are rounded
    // by the renderer, so multiplying the old size alone can clip a final row.
    const gridWidth = dimension(screen, "width") + gutter;
    const gridHeight = dimension(screen, "height");
    settledLayout = {
      metrics: [viewportWidth, viewportHeight, gridWidth - gutter, gridHeight, layout.fontSize, configured, gutter, window.devicePixelRatio, Number(allowScaling)],
      layout,
    };
    const scale = Math.min(layout.scale, Math.max(
      Math.min(1, viewportWidth / gridWidth, viewportHeight / gridHeight),
      Math.min(configured, 10) / layout.fontSize,
    ));
    visualCellHeight = gridHeight * scale / terminal.rows;
    const content = terminalContentExtent(terminal);
    contentGrid = content;
    liveContentHeight = visualCellHeight * (buffer && buffer.viewportY !== buffer.baseY
      ? terminalContentExtent(terminal, buffer.baseY).rows : content.rows);
    const visualWidth = ((gridWidth - gutter) * content.cols / terminal.cols + gutter) * scale;
    const visualHeight = visualCellHeight * content.rows;
    Object.assign(root.style, {
      position: "absolute", top: "0", left: "0", width: `${gridWidth}px`, height: `${gridHeight}px`,
      transformOrigin: "top left", transform: `scale(${scale})`,
    });
    stage.style.width = `${visualWidth}px`;
    stage.style.height = `${visualHeight}px`;
    host.style.overflowX = visualWidth > viewportWidth + 0.5 ? "auto" : "hidden";
    host.style.overflowY = visualHeight > viewportHeight + 0.5 ? "auto" : "hidden";
    options.onScale?.(scale);
    presentationScale = scale;
    // A newly visible native scrollbar consumes space on the other axis.
    const visibleWidth = host.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
    const visibleHeight = host.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom);

    const panToCell = (position: number, start: number, end: number, viewport: number, max: number) =>
      Math.max(0, Math.min(max, end > position + viewport ? end - viewport : start < position ? start : position));
    if (followY && buffer) {
      const cell = visualCellHeight;
      host.scrollTop = panToCell(host.scrollTop, buffer.cursorY * cell, (buffer.cursorY + 1) * cell,
        visibleHeight, Math.max(0, visualHeight - visibleHeight));
    } else if (visualHeight <= visibleHeight) host.scrollTop = 0;
    if (visualWidth <= visibleWidth) host.scrollLeft = 0;
    previousPan = {
      top: followY || visualHeight <= visibleHeight ? host.scrollTop : previousPan?.top ?? host.scrollTop,
      // Horizontal movement is always deliberate. Never chase the live cursor,
      // which made narrow observers appear to drift sideways as output arrived.
      left: host.scrollLeft,
    };
    if (!scrollbar && terminal.buffer && terminal.scrollToLine && terminal.onScroll && host.parentElement) {
      scrollbar = createTerminalScrollbar({ host, root, terminal: {
        buffer: terminal.buffer, scrollToLine: terminal.scrollToLine.bind(terminal), onScroll: terminal.onScroll.bind(terminal),
      }, getCellHeight: () => visualCellHeight, getTailHeight: () => liveContentHeight, onPan: () => { wheelPannedAway = true; } });
    }
    scrollbar?.sync();
    if (visibleWidth !== viewportWidth || visibleHeight !== viewportHeight) schedule();
  };

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; apply(); });
  };
  const reset = () => {
    scrollbar?.dispose();
    scrollbar = undefined;
    scrollSubscription?.dispose();
    scrollSubscription = undefined;
    outputSubscription?.dispose();
    outputSubscription = undefined;
    host.removeEventListener("mousedown", onBlankMouseDown);
    host.removeEventListener("wheel", onWheel, true);
    if (element && restoreStyle) Object.assign(element.style, restoreStyle);
    if (stage && element?.parentElement === stage) stage.replaceWith(element);
    else stage?.remove();
    stage = null;
    element = null;
    restoreStyle = null;
    previousPan = null;
    wheelPannedAway = false;
    settledLayout = null;
    host.style.overflowX = "hidden";
    host.style.overflowY = "hidden";
    options.onScale?.(1);
    presentationScale = 1;
  };
  return {
    schedule, reset,
    dispose() {
      disposed = true;
      host.removeEventListener("wheel", onWheel, true);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      reset();
    },
  };
}
