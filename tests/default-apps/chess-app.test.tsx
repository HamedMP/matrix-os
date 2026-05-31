// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// chess.js is an app-local dependency (home/apps/games/chess/node_modules).
// The root vitest runner cannot be relied upon to resolve it, and chess.js is
// itself a trusted, separately-tested library — its legality logic is not what
// this UI test verifies. We therefore mock a faithful subset of the chess.js
// API that the App consumes, seeded from the real standard opening position.
// The pure board/material/SAN helpers are exercised by chess-model.test.ts.
// ---------------------------------------------------------------------------
type Piece = { color: "w" | "b"; type: "p" | "n" | "b" | "r" | "q" | "k" };

function startingBoard(): Record<string, Piece> {
  const b: Record<string, Piece> = {};
  const back: Piece["type"][] = ["r", "n", "b", "q", "k", "b", "n", "r"];
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
  files.forEach((f, i) => {
    b[`${f}1`] = { color: "w", type: back[i] };
    b[`${f}2`] = { color: "w", type: "p" };
    b[`${f}7`] = { color: "b", type: "p" };
    b[`${f}8`] = { color: "b", type: back[i] };
  });
  return b;
}

class FakeChess {
  private board: Record<string, Piece> = startingBoard();
  private turnColor: "w" | "b" = "w";
  private moveSans: string[] = [];

  reset() {
    this.board = startingBoard();
    this.turnColor = "w";
    this.moveSans = [];
  }

  turn() {
    return this.turnColor;
  }

  get(square: string): Piece | undefined {
    return this.board[square];
  }

  // verbose moves for a specific square (only pawn double/single push needed)
  moves(opts?: { square?: string; verbose?: boolean }) {
    if (opts?.square) {
      const piece = this.board[opts.square];
      if (!piece || piece.color !== this.turnColor) return [];
      const file = opts.square[0];
      const rank = Number(opts.square[1]);
      const out: { from: string; to: string; piece: string; color: string }[] = [];
      if (piece.type === "p") {
        const dir = piece.color === "w" ? 1 : -1;
        const one = `${file}${rank + dir}`;
        const two = `${file}${rank + dir * 2}`;
        if (!this.board[one]) out.push({ from: opts.square, to: one, piece: "p", color: piece.color });
        const homeRank = piece.color === "w" ? 2 : 7;
        if (rank === homeRank && !this.board[one] && !this.board[two]) {
          out.push({ from: opts.square, to: two, piece: "p", color: piece.color });
        }
      }
      if (piece.type === "n") {
        // knight from b1 / g1 etc. — enumerate a couple of legal jumps
        const targets = piece.color === "w" ? ["a3", "c3", "f3", "h3"] : ["a6", "c6", "f6", "h6"];
        for (const t of targets) {
          if (!this.board[t]) out.push({ from: opts.square, to: t, piece: "n", color: piece.color });
        }
      }
      return opts.verbose ? out : out.map((m) => m.to);
    }
    return [];
  }

  move(m: { from: string; to: string; promotion?: string }) {
    const piece = this.board[m.from];
    if (!piece || piece.color !== this.turnColor) return null;
    const legal = (this.moves({ square: m.from, verbose: true }) as { to: string }[]).some(
      (x) => x.to === m.to,
    );
    if (!legal) return null;
    delete this.board[m.from];
    this.board[m.to] = piece;
    // crude SAN: pawn pushes are the destination square; pieces prefix letter
    const san = piece.type === "p" ? m.to : `${piece.type.toUpperCase()}${m.to}`;
    this.moveSans.push(san);
    this.turnColor = this.turnColor === "w" ? "b" : "w";
    return { from: m.from, to: m.to, san, color: piece.color, piece: piece.type, captured: undefined };
  }

  history(_opts?: { verbose?: boolean }) {
    return this.moveSans.slice();
  }

  fen() {
    return `fake ${this.moveSans.length} ${this.turnColor}`;
  }

  pgn() {
    return this.moveSans.join(" ");
  }

  isCheck() {
    return false;
  }
  isCheckmate() {
    return false;
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
    if (this.moveSans.length === 0) return null;
    this.moveSans.pop();
    this.turnColor = this.turnColor === "w" ? "b" : "w";
    return {};
  }
}

vi.mock("chess.js", () => ({ Chess: FakeChess }));

// Import App AFTER the mock is registered.
let App: React.ComponentType;

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "game-new" })),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    count: vi.fn(async () => rows.length),
    onChange: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db },
  });
  return db;
}

describe("Chess app", () => {
  beforeEach(async () => {
    window.localStorage.clear();
    ({ default: App } = await import("../../home/apps/games/chess/src/App"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    window.localStorage.clear();
  });

  it("renders an 8x8 board with 64 squares", async () => {
    installMatrixDb([]);
    render(<App />);
    const board = await screen.findByTestId("board");
    expect(board.querySelectorAll("[data-square]").length).toBe(64);
    expect(within(board).getAllByRole("gridcell").length).toBe(64);
  });

  it("highlights legal destinations when a pawn is selected", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    // select the e2 pawn
    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
    });

    // e3 and e4 should be marked as legal targets
    await waitFor(() => {
      expect(screen.getByTestId("square-e3").getAttribute("data-legal")).toBe("true");
      expect(screen.getByTestId("square-e4").getAttribute("data-legal")).toBe("true");
    });
  });

  it("records a legal move in the SAN history", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e4"));
      await Promise.resolve();
    });

    const history = await screen.findByTestId("move-history");
    expect(within(history).getByText("e4")).toBeTruthy();
  });

  it("New game resets the move history", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-e4"));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /new game/i }));

    const history = screen.getByTestId("move-history");
    expect(within(history).queryByText("e4")).toBeNull();
  });
});
