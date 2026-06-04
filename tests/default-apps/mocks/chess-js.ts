type Piece = { color: "w" | "b"; type: "p" | "n" | "b" | "r" | "q" | "k" };
type VerboseMove = {
  from: string;
  to: string;
  san: string;
  color: Piece["color"];
  piece: Piece["type"];
  captured?: Piece["type"];
  promotion?: Piece["type"];
};
type MoveRecord = VerboseMove & {
  moved: Piece;
  capturedPiece?: Piece;
};

function startingBoard(): Record<string, Piece> {
  const board: Record<string, Piece> = {};
  const back: Piece["type"][] = ["r", "n", "b", "q", "k", "b", "n", "r"];
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  files.forEach((file, i) => {
    board[`${file}1`] = { color: "w", type: back[i] };
    board[`${file}2`] = { color: "w", type: "p" };
    board[`${file}7`] = { color: "b", type: "p" };
    board[`${file}8`] = { color: "b", type: back[i] };
  });
  return board;
}

let nextBoardState: Record<string, Piece> | null = null;
let nextTurnColor: Piece["color"] = "w";
let nextCheckmate = false;
const FILES = "abcdefgh";

export function __setNextBoard(board: Record<string, Piece>, turn: Piece["color"] = "w") {
  nextBoardState = Object.fromEntries(Object.entries(board).map(([square, piece]) => [square, { ...piece }]));
  nextTurnColor = turn;
}

export function __setNextCheckmate(value = true) {
  nextCheckmate = value;
}

export function __reset() {
  nextBoardState = null;
  nextTurnColor = "w";
  nextCheckmate = false;
}

export class Chess {
  private boardState: Record<string, Piece>;
  private turnColor: Piece["color"];
  private moveStack: MoveRecord[] = [];
  private forceCheckmate: boolean;

  constructor() {
    this.boardState = nextBoardState ?? startingBoard();
    this.turnColor = nextTurnColor;
    this.forceCheckmate = nextCheckmate;
    nextBoardState = null;
    nextTurnColor = "w";
    nextCheckmate = false;
  }

  reset() {
    this.boardState = startingBoard();
    this.turnColor = "w";
    this.moveStack = [];
    this.forceCheckmate = false;
  }

  turn() {
    return this.turnColor;
  }

  get(square: string): Piece | undefined {
    return this.boardState[square];
  }

  moves(opts?: { square?: string; verbose?: boolean }) {
    if (opts?.square) {
      const piece = this.boardState[opts.square];
      if (!piece || piece.color !== this.turnColor) return [];
      const file = opts.square[0];
      const rank = Number(opts.square[1]);
      const fileIdx = FILES.indexOf(file);
      const out: Omit<VerboseMove, "san">[] = [];
      const addPawnMove = (to: string, captured?: Piece["type"]) => {
        const promotionRank = piece.color === "w" ? "8" : "1";
        const base = { from: opts.square as string, to, piece: "p" as const, color: piece.color, captured };
        if (to[1] !== promotionRank) {
          out.push(base);
          return;
        }
        for (const promotion of ["q", "r", "b", "n"] as const) out.push({ ...base, promotion });
      };
      const addTarget = (targetFileIdx: number, targetRank: number): boolean => {
        const targetFile = FILES[targetFileIdx];
        if (!targetFile || targetRank < 1 || targetRank > 8) return false;
        const target = `${targetFile}${targetRank}`;
        const occupant = this.boardState[target];
        if (!occupant) {
          out.push({ from: opts.square as string, to: target, piece: piece.type, color: piece.color });
          return true;
        }
        if (occupant.color !== piece.color) {
          out.push({ from: opts.square as string, to: target, piece: piece.type, color: piece.color, captured: occupant.type });
        }
        return false;
      };
      const addRay = (dr: number, dc: number) => {
        let nextFileIdx = fileIdx + dc;
        let nextRank = rank + dr;
        while (addTarget(nextFileIdx, nextRank)) {
          nextFileIdx += dc;
          nextRank += dr;
        }
      };
      if (piece.type === "p") {
        const dir = piece.color === "w" ? 1 : -1;
        const one = `${file}${rank + dir}`;
        const two = `${file}${rank + dir * 2}`;
        if (!this.boardState[one]) addPawnMove(one);
        const homeRank = piece.color === "w" ? 2 : 7;
        if (rank === homeRank && !this.boardState[one] && !this.boardState[two]) {
          addPawnMove(two);
        }
        for (const dc of [-1, 1]) {
          const targetFile = FILES[fileIdx + dc];
          const targetRank = rank + dir;
          if (!targetFile || targetRank < 1 || targetRank > 8) continue;
          const target = `${targetFile}${targetRank}`;
          const occupant = this.boardState[target];
          if (occupant && occupant.color !== piece.color) {
            addPawnMove(target, occupant.type);
          }
        }
      }
      if (piece.type === "n") {
        const knightDeltas = [
          [-2, -1],
          [-2, 1],
          [-1, -2],
          [-1, 2],
          [1, -2],
          [1, 2],
          [2, -1],
          [2, 1],
        ];
        for (const [dr, dc] of knightDeltas) {
          const targetFile = "abcdefgh"[fileIdx + dc];
          const targetRank = rank + dr;
          if (!targetFile || targetRank < 1 || targetRank > 8) continue;
          const target = `${targetFile}${targetRank}`;
          const occupant = this.boardState[target];
          if (!occupant || occupant.color !== piece.color) {
            out.push({ from: opts.square, to: target, piece: "n", color: piece.color, captured: occupant?.type });
          }
        }
      }
      if (piece.type === "b" || piece.type === "q") {
        for (const [dr, dc] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) addRay(dr, dc);
      }
      if (piece.type === "r" || piece.type === "q") {
        for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) addRay(dr, dc);
      }
      if (piece.type === "k") {
        for (const [dr, dc] of [[1, 1], [1, 0], [1, -1], [0, 1], [0, -1], [-1, 1], [-1, 0], [-1, -1]]) {
          addTarget(fileIdx + dc, rank + dr);
        }
      }
      return opts.verbose ? out : out.map((move) => move.to);
    }

    const out: Omit<VerboseMove, "san">[] = [];
    for (const square of Object.keys(this.boardState)) {
      const piece = this.boardState[square];
      if (piece?.color !== this.turnColor) continue;
      out.push(...(this.moves({ square, verbose: true }) as Omit<VerboseMove, "san">[]));
    }
    return opts?.verbose ? out : out.map((move) => move.to);
  }

  move(m: { from: string; to: string; promotion?: string }) {
    const piece = this.boardState[m.from];
    if (!piece || piece.color !== this.turnColor) return null;
    const legal = (this.moves({ square: m.from, verbose: true }) as { to: string }[]).some((move) => move.to === m.to);
    if (!legal) return null;

    const capturedPiece = this.boardState[m.to];
    delete this.boardState[m.from];
    this.boardState[m.to] = m.promotion ? { color: piece.color, type: m.promotion as Piece["type"] } : piece;
    const san = piece.type === "p" ? m.to : `${piece.type.toUpperCase()}${m.to}`;
    const record: MoveRecord = {
      from: m.from,
      to: m.to,
      san,
      color: piece.color,
      piece: piece.type,
      captured: capturedPiece?.type,
      promotion: m.promotion as Piece["type"] | undefined,
      moved: piece,
      capturedPiece,
    };
    this.moveStack.push(record);
    this.turnColor = this.turnColor === "w" ? "b" : "w";
    return record;
  }

  history(opts?: { verbose?: boolean }) {
    if (opts?.verbose) {
      return this.moveStack.map(({ from, to, san, color, piece, captured, promotion }) => ({
        from,
        to,
        san,
        color,
        piece,
        captured,
        promotion,
      }));
    }
    return this.moveStack.map((move) => move.san);
  }

  board() {
    const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
    return ranks.map((rank) =>
      files.map((file) => {
        const square = `${file}${rank}`;
        const piece = this.boardState[square];
        return piece ? { square, ...piece } : null;
      }),
    );
  }

  fen() {
    return `fake ${this.moveStack.length} ${this.turnColor}`;
  }

  pgn() {
    return this.moveStack.map((move) => move.san).join(" ");
  }

  isCheck() {
    return false;
  }
  isCheckmate() {
    return this.forceCheckmate && this.moveStack.length > 0;
  }
  isStalemate() {
    return false;
  }
  isDraw() {
    return false;
  }
  isGameOver() {
    return false;
  }
  undo() {
    const last = this.moveStack.pop();
    if (!last) return null;
    delete this.boardState[last.to];
    this.boardState[last.from] = last.moved;
    if (last.capturedPiece) {
      this.boardState[last.to] = last.capturedPiece;
    }
    this.turnColor = this.turnColor === "w" ? "b" : "w";
    return last;
  }
}
