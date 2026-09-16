import { computeSoftGridLayout } from "./terminal-soft-grid.js";

interface GridTerminal {
  element?: HTMLElement | null;
  cols: number;
  rows: number;
  options: { fontSize?: number; scrollback?: number; overviewRuler?: { width?: number } };
  buffer?: { active: { baseY: number; viewportY: number; cursorX: number; cursorY: number } };
}

interface GridPresentationOptions {
  host: HTMLElement;
  getTerminal: () => GridTerminal;
  getConfiguredFontSize: () => number;
  enabled?: () => boolean;
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

/** Local presentation only: never changes the server-owned rows or columns. */
export function createTerminalGridPresentation(options: GridPresentationOptions) {
  const { host } = options;
  let frame: number | null = null;
  let disposed = false;
  let stage: HTMLElement | null = null;
  let element: HTMLElement | null = null;
  let restoreStyle: Partial<CSSStyleDeclaration> | null = null;
  let previousPan: { top: number; left: number } | null = null;
  let presentationScale = 1;

  const onWheel = (event: WheelEvent & { matrixGridCorrected?: boolean }) => {
    if (event.matrixGridCorrected || !element || !(event.target instanceof Element) || !element.contains(event.target)) return;
    const scale = presentationScale * (options.getParentScale?.() ?? 1);
    if (!Number.isFinite(scale) || scale <= 0 || scale === 1) return;
    const rect = element.getBoundingClientRect();
    const corrected = new WheelEvent("wheel", {
      bubbles: event.bubbles, cancelable: event.cancelable, composed: event.composed,
      clientX: rect.left + (event.clientX - rect.left) / scale,
      clientY: rect.top + (event.clientY - rect.top) / scale,
      screenX: event.screenX, screenY: event.screenY,
      deltaX: event.deltaX, deltaY: event.deltaY, deltaZ: event.deltaZ, deltaMode: event.deltaMode,
      ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey,
      button: event.button, buttons: event.buttons,
    });
    Object.defineProperty(corrected, "matrixGridCorrected", { value: true });
    event.stopImmediatePropagation();
    event.target.dispatchEvent(corrected);
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
    const gutter = terminal.options.scrollback === 0 ? 0 : terminal.options.overviewRuler?.width || 14;
    const layout = computeSoftGridLayout({
      viewportWidth, viewportHeight,
      gridWidth: width * configured / fontSize + gutter,
      gridHeight: height * configured / fontSize,
      configuredFontSize: configured,
      minimumReadableFontSize: 10,
      devicePixelRatio: window.devicePixelRatio,
    });
    const buffer = terminal.buffer?.active;
    const live = buffer && buffer.viewportY >= buffer.baseY;
    const followY = live && (!previousPan || Math.abs(host.scrollTop - previousPan.top) <= 1);
    const followX = live && (!previousPan || Math.abs(host.scrollLeft - previousPan.left) <= 1);

    if (!stage) {
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
      Object.assign(stage.style, { position: "relative", overflow: "hidden", flexShrink: "0" });
      root.before(stage);
      stage.append(root);
    }
    if (Math.abs(fontSize - layout.fontSize) > 0.01) terminal.options.fontSize = layout.fontSize;
    // Use measured cell metrics after font changes; glyph metrics are rounded
    // by the renderer, so multiplying the old size alone can clip a final row.
    const gridWidth = dimension(screen, "width") + gutter;
    const gridHeight = dimension(screen, "height");
    const scale = Math.min(layout.scale, Math.max(
      Math.min(1, viewportWidth / gridWidth, viewportHeight / gridHeight),
      Math.min(configured, 10) / layout.fontSize,
    ));
    const visualWidth = gridWidth * scale;
    const visualHeight = gridHeight * scale;
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
      const cell = visualHeight / terminal.rows;
      host.scrollTop = panToCell(host.scrollTop, buffer.cursorY * cell, (buffer.cursorY + 1) * cell,
        visibleHeight, Math.max(0, visualHeight - visibleHeight));
    } else if (visualHeight <= visibleHeight) host.scrollTop = 0;
    if (followX && buffer) {
      const cell = dimension(screen, "width") * scale / terminal.cols;
      host.scrollLeft = panToCell(host.scrollLeft, buffer.cursorX * cell, (buffer.cursorX + 1) * cell,
        visibleWidth, Math.max(0, visualWidth - visibleWidth));
    } else if (visualWidth <= visibleWidth) host.scrollLeft = 0;
    previousPan = {
      top: followY || visualHeight <= visibleHeight ? host.scrollTop : previousPan?.top ?? host.scrollTop,
      left: followX || visualWidth <= visibleWidth ? host.scrollLeft : previousPan?.left ?? host.scrollLeft,
    };
    if (visibleWidth !== viewportWidth || visibleHeight !== viewportHeight) schedule();
  };

  const schedule = () => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => { frame = null; apply(); });
  };
  const reset = () => {
    host.removeEventListener("wheel", onWheel, true);
    if (element && restoreStyle) Object.assign(element.style, restoreStyle);
    if (stage && element?.parentElement === stage) stage.replaceWith(element);
    else stage?.remove();
    stage = null;
    element = null;
    restoreStyle = null;
    previousPan = null;
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
