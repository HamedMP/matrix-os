import type { WindowBounds } from "./WindowResizeControls.js";

export const WINDOW_BACKGROUND_CLICK_BUFFER = 12;
const SIDE_OVERFLOW = 32;
const TOP_OVERFLOW = 16; // A 48px title bar retains 32px for dragging and controls.

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function constrainAxis(
  position: number, size: number, minimum: number, low: number, high: number,
  previousPosition?: number, previousSize?: number,
): [number, number] {
  const requestedPosition = finite(position, 0);
  const requestedSize = finite(size, minimum);
  const limitedSize = clamp(requestedSize, minimum, high - low);
  if (previousPosition !== undefined && previousSize !== undefined && requestedSize !== previousSize) {
    if (Math.abs(requestedPosition - previousPosition) < 0.01) {
      const start = clamp(previousPosition, low, high - minimum);
      return [start, clamp(requestedSize, minimum, high - start)];
    }
    const previousEnd = previousPosition + previousSize;
    if (Math.abs(requestedPosition + requestedSize - previousEnd) < 0.01) {
      const end = clamp(previousEnd, low + minimum, high);
      const start = clamp(requestedPosition, low, end - minimum);
      return [start, end - start];
    }
  }
  return [clamp(requestedPosition, low, high - limitedSize), limitedSize];
}

/** Floating windows may cross the work-area border while remaining recoverable.
 * During a resize, retain the stationary edge when reaching the overflow limit.
 */
export function constrainFloatingWindow(
  bounds: WindowBounds,
  viewport: { width: number; height: number },
  minimum: { width: number; height: number },
  previous?: WindowBounds,
): WindowBounds {
  const vw = Math.max(1, finite(viewport.width, 1));
  const vh = Math.max(1, finite(viewport.height, 1));
  const [x, width] = constrainAxis(bounds.x, bounds.width, Math.min(minimum.width, vw),
    -SIDE_OVERFLOW, vw + SIDE_OVERFLOW, previous?.x, previous?.width);
  const [y, height] = constrainAxis(bounds.y, bounds.height, Math.min(minimum.height, vh),
    -TOP_OVERFLOW, vh + SIDE_OVERFLOW, previous?.y, previous?.height);
  return { x, y, width, height };
}

export function isPointNearWindow(
  point: { x: number; y: number },
  bounds: WindowBounds,
  buffer = WINDOW_BACKGROUND_CLICK_BUFFER,
): boolean {
  return bounds.width > 0 && bounds.height > 0
    && point.x >= bounds.x - buffer && point.x <= bounds.x + bounds.width + buffer
    && point.y >= bounds.y - buffer && point.y <= bounds.y + bounds.height + buffer;
}
