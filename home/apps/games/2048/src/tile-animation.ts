import type { Board, Direction } from "./game-2048";

export interface Tile {
  id: number;
  value: number;
  row: number;
  col: number;
  merged?: boolean;
  spawned?: boolean;
}

let TILE_SEQ = 1;

export function nextTileId(): number {
  TILE_SEQ += 1;
  return TILE_SEQ;
}

export function resetTileIdsForTest(): void {
  TILE_SEQ = 1;
}

function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function tilesFromBoard(
  board: Board,
  previous: Tile[] = [],
  spawned: { row: number; col: number; value: number } | null = null,
  mergedCells: readonly string[] = [],
  consumedCells: readonly string[] = [],
  direction?: Direction,
): Tile[] {
  const tiles: Tile[] = [];
  const used = previous
    .filter((tile) => consumedCells.includes(cellKey(tile.row, tile.col)))
    .map((tile) => tile.id);
  for (let r = 0; r < board.length; r += 1) {
    for (let c = 0; c < board[r].length; c += 1) {
      if (board[r][c] !== 0) {
        if (spawned && spawned.row === r && spawned.col === c && spawned.value === board[r][c]) {
          tiles.push({ id: nextTileId(), value: board[r][c], row: r, col: c, spawned: true });
          continue;
        }
        if (mergedCells.includes(cellKey(r, c))) {
          tiles.push({ id: nextTileId(), value: board[r][c], row: r, col: c, spawned: false, merged: true });
          continue;
        }
        const lineMatch = direction
          ? previous
            .filter((tile) =>
              tile.value === board[r][c] &&
              !used.includes(tile.id) &&
              (direction === "left" || direction === "right" ? tile.row === r : tile.col === c),
            )
            .sort((a, b) => (direction === "left" || direction === "right" ? a.col - b.col : a.row - b.row))[0]
          : null;
        const match = previous
          .filter((tile) => tile.value === board[r][c] && !used.includes(tile.id))
          .sort((a, b) => {
            const distance = Math.abs(a.row - r) + Math.abs(a.col - c) - (Math.abs(b.row - r) + Math.abs(b.col - c));
            if (distance !== 0) return distance;
            if (a.row !== b.row) return a.row - b.row;
            return a.col - b.col;
          })[0];
        const resolved = lineMatch ?? match;
        if (resolved) {
          used.push(resolved.id);
          tiles.push({ ...resolved, row: r, col: c, spawned: false, merged: false });
        } else {
          tiles.push({ id: nextTileId(), value: board[r][c], row: r, col: c, spawned: false, merged: false });
        }
      }
    }
  }
  return tiles;
}
