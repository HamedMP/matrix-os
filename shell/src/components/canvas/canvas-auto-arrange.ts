import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";

interface WindowRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface TiledRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const GAP = 24;
const MIN_TILE_WIDTH = 420;
const MIN_TILE_HEIGHT = 300;

function chooseBalancedGrid(count: number, viewportWidth: number, viewportHeight: number) {
  let best = { cols: count, rows: 1, score: Number.POSITIVE_INFINITY };
  const targetAspect = viewportWidth / Math.max(1, viewportHeight);

  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const boardAspect = cols / rows;
    const emptyCells = cols * rows - count;
    const score = Math.abs(boardAspect - targetAspect) + emptyCells * 0.18;
    if (score < best.score) best = { cols, rows, score };
  }

  return best;
}

function slotRect(col: number, row: number, colSpan: number, rowSpan: number, cellW: number, cellH: number) {
  return {
    x: col * (cellW + GAP),
    y: row * (cellH + GAP),
    width: cellW * colSpan + GAP * (colSpan - 1),
    height: cellH * rowSpan + GAP * (rowSpan - 1),
  };
}

export function computeTiledWindowLayout(
  windows: WindowRect[],
  viewportWidth: number,
  viewportHeight: number,
): TiledRect[] {
  if (windows.length === 0) return [];

  const sorted = windows.toSorted((a, b) => {
    const rowA = Math.round(a.y / 200);
    const rowB = Math.round(b.y / 200);
    if (rowA !== rowB) return rowA - rowB;
    return a.x - b.x;
  });

  const count = sorted.length;
  const landscape = viewportWidth >= viewportHeight;
  const boardW = Math.max(MIN_TILE_WIDTH, Math.round(viewportWidth * 0.82));
  const boardH = Math.max(MIN_TILE_HEIGHT, Math.round(viewportHeight * 0.76));
  let slots: Array<{ x: number; y: number; width: number; height: number }> = [];

  if (count === 1) {
    slots = [{
      x: 0,
      y: 0,
      width: Math.max(MIN_TILE_WIDTH, Math.round(boardW * 0.72)),
      height: Math.max(MIN_TILE_HEIGHT, Math.round(boardH * 0.78)),
    }];
  } else if (count === 2) {
    const cols = landscape ? 2 : 1;
    const rows = landscape ? 1 : 2;
    const cellW = Math.max(MIN_TILE_WIDTH, Math.round((boardW - GAP * (cols - 1)) / cols));
    const cellH = Math.max(MIN_TILE_HEIGHT, Math.round((boardH - GAP * (rows - 1)) / rows));
    slots = sorted.map((_, i) => slotRect(landscape ? i : 0, landscape ? 0 : i, 1, 1, cellW, cellH));
  } else if (count === 3) {
    if (landscape) {
      const cellW = Math.max(MIN_TILE_WIDTH, Math.round((boardW - GAP) / 2));
      const cellH = Math.max(MIN_TILE_HEIGHT, Math.round((boardH - GAP) / 2));
      slots = [
        slotRect(0, 0, 1, 2, cellW, cellH),
        slotRect(1, 0, 1, 1, cellW, cellH),
        slotRect(1, 1, 1, 1, cellW, cellH),
      ];
    } else {
      const cellW = Math.max(MIN_TILE_WIDTH, Math.round((boardW - GAP) / 2));
      const cellH = Math.max(MIN_TILE_HEIGHT, Math.round((boardH - GAP) / 2));
      slots = [
        slotRect(0, 0, 2, 1, cellW, cellH),
        slotRect(0, 1, 1, 1, cellW, cellH),
        slotRect(1, 1, 1, 1, cellW, cellH),
      ];
    }
  } else {
    const { cols, rows } = count === 4
      ? { cols: 2, rows: 2 }
      : chooseBalancedGrid(count, viewportWidth, viewportHeight);
    const cellW = Math.max(MIN_TILE_WIDTH, Math.round((boardW - GAP * (cols - 1)) / cols));
    const cellH = Math.max(MIN_TILE_HEIGHT, Math.round((boardH - GAP * (rows - 1)) / rows));
    slots = sorted.map((_, i) => {
      const row = Math.floor(i / cols);
      const rowCount = Math.min(cols, count - row * cols);
      const missingCols = cols - rowCount;
      const rowOffsetX = missingCols > 0 ? (missingCols * (cellW + GAP)) / 2 : 0;
      const slot = slotRect(i % cols, row, 1, 1, cellW, cellH);
      return { ...slot, x: slot.x + rowOffsetX };
    });
  }

  const minX = Math.min(...slots.map((slot) => slot.x));
  const minY = Math.min(...slots.map((slot) => slot.y));
  const maxX = Math.max(...slots.map((slot) => slot.x + slot.width));
  const boardOffsetX = -((maxX - minX) / 2);
  const boardOffsetY = GAP;

  return sorted.map((win, i) => {
    const slot = slots[i];
    return {
      id: win.id,
      x: Math.round(slot.x + boardOffsetX),
      y: Math.round(slot.y - minY + boardOffsetY),
      width: Math.round(slot.width),
      height: Math.round(slot.height),
    };
  });
}

export function autoArrangeWindows() {
  const wm = useWindowManager.getState();
  const wins = wm.windows.filter((w) => !w.minimized);
  if (wins.length === 0) return;

  const cRect = useCanvasTransform.getState().containerRect;
  const arrangedRects = computeTiledWindowLayout(
    wins,
    cRect?.width ?? window.innerWidth,
    cRect?.height ?? window.innerHeight,
  );
  const byId = new Map(arrangedRects.map((rect) => [rect.id, rect]));
  wm.setWindows((prev) => prev.map((win) => {
    const rect = byId.get(win.id);
    return rect ? { ...win, ...rect } : win;
  }));

  if (arrangedRects.length > 0) {
    useCanvasTransform.getState().fitAll(
      arrangedRects.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
      cRect?.width ?? window.innerWidth,
      cRect?.height ?? window.innerHeight,
    );
  }
}
