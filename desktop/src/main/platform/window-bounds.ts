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

export function fitWindowBoundsToWorkArea(
  bounds: WindowBounds,
  workArea: WorkArea,
): Required<WindowBounds> {
  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const maxX = workArea.x + workArea.width - width;
  const maxY = workArea.y + workArea.height - height;

  return {
    x: Math.min(Math.max(bounds.x ?? workArea.x, workArea.x), maxX),
    y: Math.min(Math.max(bounds.y ?? workArea.y, workArea.y), maxY),
    width,
    height,
  };
}
