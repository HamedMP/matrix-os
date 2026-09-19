interface ContentTerminal {
  cols: number;
  rows: number;
  buffer?: { active: {
    type?: string;
    baseY: number;
    viewportY: number;
    cursorX: number;
    cursorY: number;
    getLine?: (row: number) => {
      getCell(column: number): { getChars(): string; getWidth(): number; isBgDefault(): boolean; isInverse?: () => number } | undefined;
    } | undefined;
  } };
}

/** Trim unused normal-screen space without discarding cursor or painted cells. */
export function terminalContentExtent(terminal: ContentTerminal, viewportY = terminal.buffer?.active.viewportY ?? 0) {
  const buffer = terminal.buffer?.active;
  if (!buffer?.getLine || buffer.type === "alternate") return { cols: terminal.cols, rows: terminal.rows };
  let cols = 1, rows = 1;
  if (viewportY === buffer.baseY) {
    cols = buffer.cursorX + 1;
    rows = buffer.cursorY + 1;
  }
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(viewportY + row);
    if (!line) continue;
    let end = 0;
    // Inspect cells, not JS string length: wide glyphs occupy multiple columns.
    // Background-painted spaces are visible TUI content, not empty margins.
    for (let column = terminal.cols - 1; column >= 0; column--) {
      const cell = line.getCell(column);
      if (cell && (cell.getChars().trim() || !cell.isBgDefault() || cell.isInverse?.())) {
        end = column + Math.max(1, cell.getWidth());
        break;
      }
    }
    if (end > 0) { cols = Math.max(cols, end); rows = row + 1 > rows ? row + 1 : rows; }
  }
  return { cols: Math.min(terminal.cols, cols), rows: Math.min(terminal.rows, rows) };
}
