/** Consume local grid overflow before handing the remaining gesture to xterm. */
export function panTerminalGrid(
  event: WheelEvent,
  host: HTMLElement,
  stage: HTMLElement,
  grid: { cols: number; rows: number },
) {
  let deltaX = event.deltaX;
  let deltaY = event.deltaY;
  if (!event.cancelable || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
    return { deltaX, deltaY, panned: false, verticalPanned: false };
  }
  const consume = (axis: "x" | "y", delta: number) => {
    const vertical = axis === "y";
    const viewport = vertical ? host.clientHeight : host.clientWidth;
    const extent = vertical ? host.scrollHeight : host.scrollWidth;
    const overflow = vertical ? host.style.overflowY : host.style.overflowX;
    if (!delta || (overflow !== "auto" && overflow !== "scroll") || extent <= viewport) return delta;
    const cells = vertical ? grid.rows : grid.cols;
    const size = Number.parseFloat(vertical ? stage.style.height : stage.style.width);
    const unit = event.deltaMode === 1 ? size / cells : event.deltaMode === 2 ? viewport : 1;
    if (!Number.isFinite(unit) || unit <= 0) return delta;
    const before = vertical ? host.scrollTop : host.scrollLeft;
    const next = Math.max(0, Math.min(extent - viewport, before + delta * unit));
    if (vertical) host.scrollTop = next;
    else host.scrollLeft = next;
    const after = vertical ? host.scrollTop : host.scrollLeft;
    const remaining = delta - (after - before) / unit;
    return Math.abs(remaining) < 1e-7 ? 0 : remaining;
  };
  deltaX = consume("x", deltaX);
  deltaY = consume("y", deltaY);
  return {
    deltaX, deltaY,
    panned: deltaX !== event.deltaX || deltaY !== event.deltaY,
    verticalPanned: deltaY !== event.deltaY,
  };
}
