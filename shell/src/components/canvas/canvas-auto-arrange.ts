import { useCanvasTransform } from "@/hooks/useCanvasTransform";
import { useWindowManager } from "@/hooks/useWindowManager";

export function autoArrangeWindows() {
  const wm = useWindowManager.getState();
  const wins = wm.windows.filter((w) => !w.minimized);
  if (wins.length === 0) return;

  const sorted = [...wins].sort((a, b) => {
    const rowA = Math.round(a.y / 200);
    const rowB = Math.round(b.y / 200);
    if (rowA !== rowB) return rowA - rowB;
    return a.x - b.x;
  });

  const gap = 24;
  const viewW = window.innerWidth;
  const avgWidth = sorted.reduce((s, w) => s + w.width, 0) / sorted.length;
  const cols = Math.max(1, Math.min(sorted.length, Math.floor((viewW * 0.8) / (avgWidth + gap))));

  const rows: typeof sorted[] = [];
  for (let i = 0; i < sorted.length; i += cols) {
    rows.push(sorted.slice(i, i + cols));
  }

  let currentY = gap;
  for (const row of rows) {
    const totalWidth = row.reduce((s, w) => s + w.width, 0) + (row.length - 1) * gap;
    let currentX = -totalWidth / 2;
    let rowHeight = 0;

    for (const win of row) {
      wm.moveWindow(win.id, currentX, currentY);
      currentX += win.width + gap;
      rowHeight = Math.max(rowHeight, win.height);
    }

    currentY += rowHeight + gap;
  }

  const arranged = useWindowManager.getState().windows.filter((w) => !w.minimized);
  const cRect = useCanvasTransform.getState().containerRect;
  useCanvasTransform.getState().fitAll(
    arranged.map((w) => ({ x: w.x, y: w.y, width: w.width, height: w.height })),
    cRect?.width ?? window.innerWidth,
    cRect?.height ?? window.innerHeight,
  );
}
