// App-wide zoom math shared by the View menu and the IPC handlers. Factors
// stay in 0.1 steps inside [0.5, 2.0]; rounding keeps repeated steps free of
// floating-point drift.
export const MIN_ZOOM_FACTOR = 0.5;
export const MAX_ZOOM_FACTOR = 2.0;
export const DEFAULT_ZOOM_FACTOR = 1.0;
export const ZOOM_STEP = 0.1;

export type ZoomAction = "in" | "out" | "reset";

export function clampZoomFactor(factor: number): number {
  if (!Number.isFinite(factor)) return DEFAULT_ZOOM_FACTOR;
  const rounded = Math.round(factor * 10) / 10;
  return Math.min(MAX_ZOOM_FACTOR, Math.max(MIN_ZOOM_FACTOR, rounded));
}

export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === "reset") return DEFAULT_ZOOM_FACTOR;
  return clampZoomFactor(current + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
}
