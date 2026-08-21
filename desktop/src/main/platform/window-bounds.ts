export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface WorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FittedWindowBounds extends Required<WindowBounds> {
  minWidth: number;
  minHeight: number;
}

const PREFERRED_MIN_WIDTH = 880;
const PREFERRED_MIN_HEIGHT = 560;

export function fitWindowBoundsToWorkArea(
  bounds: WindowBounds,
  workArea: WorkArea,
): FittedWindowBounds {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  return {
    x: Math.min(Math.max(bounds.x ?? workArea.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y ?? workArea.y, workArea.y), maxY),
    width,
    height,
    minWidth: Math.min(PREFERRED_MIN_WIDTH, width),
    minHeight: Math.min(PREFERRED_MIN_HEIGHT, height),
  };
}
