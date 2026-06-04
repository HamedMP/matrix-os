import { describe, expect, it } from "vitest";
import {
  type BoardSquare,
  type ChessLike,
  type VerboseMove,
  evaluatePosition,
  findBestMove,
} from "../../home/apps/games/chess/src/chess-ai";

type Node = {
  turn: "w" | "b";
  board: (BoardSquare | null)[][];
  moves?: VerboseMove[];
  checkmate?: boolean;
  stalemate?: boolean;
  draw?: boolean;
};

function emptyBoard(): (BoardSquare | null)[][] {
  return Array.from({ length: 8 }, () => Array<BoardSquare | null>(8).fill(null));
}

function boardWith(pieces: Array<BoardSquare & { row: number; col: number }>): (BoardSquare | null)[][] {
  const board = emptyBoard();
  for (const piece of pieces) {
    board[piece.row][piece.col] = { square: piece.square, type: piece.type, color: piece.color };
  }
  return board;
}

class MockChess implements ChessLike {
  private current: string;
  private readonly history: string[] = [];

  constructor(
    private readonly nodes: Record<string, Node>,
    start = "root",
  ) {
    this.current = start;
  }

  moves(): VerboseMove[] {
    return this.nodes[this.current].moves ?? [];
  }

  move(m: { from: string; to: string }): unknown {
    this.history.push(this.current);
    this.current = `${m.from}${m.to}`;
    return m;
  }

  undo(): unknown {
    const prev = this.history.pop();
    if (prev) this.current = prev;
    return null;
  }

  turn(): "w" | "b" {
    return this.nodes[this.current].turn;
  }

  board(): (BoardSquare | null)[][] {
    return this.nodes[this.current].board;
  }

  isCheckmate(): boolean {
    return Boolean(this.nodes[this.current].checkmate);
  }

  isStalemate(): boolean {
    return Boolean(this.nodes[this.current].stalemate);
  }

  isDraw(): boolean {
    return Boolean(this.nodes[this.current].draw);
  }
}

const quietBoard = boardWith([
  { square: "e1", row: 7, col: 4, color: "w", type: "k" },
  { square: "e8", row: 0, col: 4, color: "b", type: "k" },
]);

function move(from: string, to: string, piece: VerboseMove["piece"], captured?: VerboseMove["captured"]): VerboseMove {
  return { from, to, piece, captured, color: "w" };
}

describe("chess-ai engine", () => {
  it("returns a legal move from the current position", () => {
    const moves = [move("a2", "a3", "p"), move("h2", "h3", "p")];
    const game = new MockChess({
      root: { turn: "w", board: quietBoard, moves },
      a2a3: { turn: "b", board: quietBoard },
      h2h3: { turn: "b", board: quietBoard },
    });

    const best = findBestMove(game, 2);

    expect(best).not.toBeNull();
    expect(moves.map((m) => `${m.from}${m.to}`)).toContain(`${best!.from}${best!.to}`);
  });

  it("finds an immediate mating move", () => {
    const game = new MockChess({
      root: {
        turn: "w",
        board: quietBoard,
        moves: [move("a1", "a8", "r"), move("a1", "a7", "r")],
      },
      a1a8: { turn: "b", board: quietBoard, checkmate: true },
      a1a7: { turn: "b", board: quietBoard },
    });

    expect(findBestMove(game, 3)).toEqual({ from: "a1", to: "a8", promotion: undefined });
  });

  it("captures a hanging queen before a lower-value piece", () => {
    const queenWin = boardWith([
      { square: "e1", row: 7, col: 4, color: "w", type: "k" },
      { square: "e8", row: 0, col: 4, color: "b", type: "k" },
      { square: "d8", row: 0, col: 3, color: "w", type: "r" },
      { square: "a8", row: 0, col: 0, color: "b", type: "n" },
    ]);
    const knightWin = boardWith([
      { square: "e1", row: 7, col: 4, color: "w", type: "k" },
      { square: "e8", row: 0, col: 4, color: "b", type: "k" },
      { square: "a8", row: 0, col: 0, color: "w", type: "r" },
      { square: "d8", row: 0, col: 3, color: "b", type: "q" },
    ]);
    const game = new MockChess({
      root: {
        turn: "w",
        board: quietBoard,
        moves: [move("d1", "a8", "r", "n"), move("d1", "d8", "r", "q")],
      },
      d1a8: { turn: "b", board: knightWin },
      d1d8: { turn: "b", board: queenWin },
    });

    expect(findBestMove(game, 2)).toEqual({ from: "d1", to: "d8", promotion: undefined });
  });

  it("evaluation favors the side with more material", () => {
    const up = evaluatePosition(new MockChess({
      root: {
        turn: "w",
        board: boardWith([
          { square: "e1", row: 7, col: 4, color: "w", type: "k" },
          { square: "e8", row: 0, col: 4, color: "b", type: "k" },
          { square: "d1", row: 7, col: 3, color: "w", type: "q" },
        ]),
      },
    }));
    const even = evaluatePosition(new MockChess({ root: { turn: "w", board: quietBoard } }));
    expect(up).toBeGreaterThan(even);
  });

  it("evaluation treats terminal positions explicitly", () => {
    expect(evaluatePosition(new MockChess({
      root: { turn: "w", board: quietBoard, checkmate: true },
    }))).toBeLessThan(-90_000);
    expect(evaluatePosition(new MockChess({
      root: { turn: "w", board: quietBoard, stalemate: true },
    }))).toBe(0);
    expect(evaluatePosition(new MockChess({
      root: { turn: "w", board: quietBoard, draw: true },
    }))).toBe(0);
  });

  it("search handles stalemate child nodes as draws", () => {
    const game = new MockChess({
      root: {
        turn: "w",
        board: quietBoard,
        moves: [move("a2", "a3", "p")],
      },
      a2a3: { turn: "b", board: quietBoard, stalemate: true },
    });

    expect(findBestMove(game, 2)).toEqual({ from: "a2", to: "a3", promotion: undefined });
  });

  it("is deterministic for a fixed position and depth", () => {
    const nodes = {
      root: { turn: "w" as const, board: quietBoard, moves: [move("a2", "a3", "p"), move("h2", "h3", "p")] },
      a2a3: { turn: "b" as const, board: quietBoard },
      h2h3: { turn: "b" as const, board: quietBoard },
    };
    const a = findBestMove(new MockChess(nodes), 2);
    const b = findBestMove(new MockChess(nodes), 2);
    expect(a).toEqual(b);
  });

  it("returns null when there are no legal moves", () => {
    expect(findBestMove(new MockChess({ root: { turn: "b", board: quietBoard, moves: [], checkmate: true } }), 2)).toBeNull();
  });
});
