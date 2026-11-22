export type LauncherGridKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End";

const GRID_KEYS: ReadonlySet<string> = new Set<LauncherGridKey>(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"]);

export function isLauncherGridKey(key: string): key is LauncherGridKey {
  return GRID_KEYS.has(key);
}

/** Columns in a wrapped grid: the tiles that share the first tile's row (offsetTop). */
export function countGridColumns(tileOffsetTops: readonly number[]): number {
  if (tileOffsetTops.length === 0) return 1;
  const firstRowTop = tileOffsetTops[0];
  let columns = 0;
  while (columns < tileOffsetTops.length && tileOffsetTops[columns] === firstRowTop) columns += 1;
  return Math.max(1, columns);
}

/**
 * The tile a grid key moves to. Edges never wrap; ArrowDown onto a shorter last row lands on
 * that row's last tile.
 */
export function nextLauncherGridIndex({ index, count, columns, key }: {
  index: number;
  count: number;
  columns: number;
  key: LauncherGridKey;
}): number {
  if (count <= 0) return 0;
  const last = count - 1;
  const current = Math.min(Math.max(0, index), last);
  const width = Math.max(1, Math.floor(columns));
  switch (key) {
    case "ArrowLeft": return Math.max(0, current - 1);
    case "ArrowRight": return Math.min(last, current + 1);
    case "Home": return 0;
    case "End": return last;
    case "ArrowUp": return current - width >= 0 ? current - width : current;
    case "ArrowDown": {
      const onLastRow = Math.floor(current / width) === Math.floor(last / width);
      return onLastRow ? current : Math.min(last, current + width);
    }
  }
}

/**
 * Whether a grid key should move the highlight instead of the search caret. Up/Down always
 * navigate. Left/Home navigate when the search is empty or the caret sits at the start with
 * nothing selected; Right/End when it is empty or the caret sits at the end.
 */
export function launcherGridKeyNavigates(
  key: LauncherGridKey,
  input: { value: string; selectionStart: number | null; selectionEnd: number | null },
): boolean {
  if (key === "ArrowUp" || key === "ArrowDown" || input.value === "") return true;
  if (input.selectionStart === null || input.selectionStart !== input.selectionEnd) return false;
  return key === "ArrowLeft" || key === "Home"
    ? input.selectionStart === 0
    : input.selectionStart === input.value.length;
}
