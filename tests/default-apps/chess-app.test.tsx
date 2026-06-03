// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findBestMove } from "../../home/apps/games/chess/src/chess-ai";

type DbRow = Record<string, unknown>;
type ChessMockControls = {
  __setNextBoard(board: Record<string, { color: "w" | "b"; type: "p" | "n" | "b" | "r" | "q" | "k" }>, turn?: "w" | "b"): void;
  __setNextCheckmate(value?: boolean): void;
  __reset(): void;
  Chess: new () => {
    moves(opts: { square: string }): string[];
    moves(opts: { square: string; verbose: true }): Array<{ to: string; promotion?: string }>;
  };
};

let App: React.ComponentType;

vi.mock("../../home/apps/games/chess/src/chess-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../home/apps/games/chess/src/chess-ai")>();
  return {
    ...actual,
    findBestMove: vi.fn(actual.findBestMove),
  };
});

function installMatrixDb(rows: DbRow[] = []) {
  const listeners: Array<() => void> = [];
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "game-new" })),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    count: vi.fn(async () => rows.length),
    onChange: vi.fn((_table: string, cb: () => void) => {
      listeners.push(cb);
      return () => {
        const index = listeners.indexOf(cb);
        if (index >= 0) listeners.splice(index, 1);
      };
    }),
    emitChange: () => {
      for (const cb of [...listeners]) cb();
    },
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

  afterEach(async () => {
    cleanup();
    const { __reset } = await import("chess.js") as unknown as ChessMockControls;
    __reset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
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

  it("shows a save-strip error when saved game stats fail to load", async () => {
    const db = installMatrixDb([]);
    db.count.mockRejectedValueOnce(new Error("count failed"));

    render(<App />);

    expect(await screen.findByText("Saved games could not be loaded.")).toBeTruthy();
  });

  it("clears a stats load error after a successful db change reload", async () => {
    const db = installMatrixDb([{}]);
    db.count.mockRejectedValueOnce(new Error("count failed")).mockResolvedValueOnce(1);

    render(<App />);

    expect(await screen.findByText("Saved games could not be loaded.")).toBeTruthy();

    await act(async () => {
      db.emitChange();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText("Saved games could not be loaded.")).toBeNull());
    expect(screen.queryByText("Game could not be saved.")).toBeNull();
    expect(screen.getByText("1 game on record")).toBeTruthy();
  });

  it("keeps a save error visible during stats change reloads", async () => {
    const { __setNextCheckmate } = await import("chess.js") as unknown as ChessMockControls;
    __setNextCheckmate();
    const db = installMatrixDb([]);
    db.insert.mockRejectedValueOnce(new Error("save failed"));
    db.count.mockResolvedValue(1);

    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-e4"));
      await Promise.resolve();
    });

    expect(await screen.findByText("This game could not be saved.")).toBeTruthy();

    await act(async () => {
      db.emitChange();
      await Promise.resolve();
    });

    expect(screen.getByText("This game could not be saved.")).toBeTruthy();
    expect(screen.queryByText("1 game on record")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /new game/i }));

    expect(screen.queryByText("This game could not be saved.")).toBeNull();
    expect(screen.getByText("1 game on record")).toBeTruthy();
  });

  it("keeps a successful save visible when a later stats reload would fail", async () => {
    const { __setNextCheckmate } = await import("chess.js") as unknown as ChessMockControls;
    __setNextCheckmate();
    const db = installMatrixDb([]);
    db.count.mockResolvedValueOnce(0).mockRejectedValueOnce(new Error("count failed"));

    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-e4"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Game saved")).toBeTruthy();
    expect(screen.queryByText("Saved games could not be loaded.")).toBeNull();
  });

  it("keeps undo locked while a finished game save is pending", async () => {
    const { __setNextCheckmate } = await import("chess.js") as unknown as ChessMockControls;
    __setNextCheckmate();
    const db = installMatrixDb([]);
    let resolveInsert: ((value: { id: string }) => void) | null = null;
    db.insert.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInsert = resolve;
        }),
    );

    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-e4"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Saving game to Matrix Postgres…")).toBeTruthy();
    const undoButton = screen.getByRole("button", { name: /undo/i }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(true);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    expect(screen.getByTestId("square-e4").getAttribute("aria-label")).toBe("e4 White p");
    expect(screen.getByTestId("square-e2").getAttribute("aria-label")).toBe("e2 empty");
    expect(db.insert).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInsert?.({ id: "game-new" });
      await Promise.resolve();
    });
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

  it("mock chess legal moves cover sliding pieces and kings", async () => {
    const { Chess, __setNextBoard } = await import("chess.js") as unknown as ChessMockControls;

    __setNextBoard({
      d4: { color: "w", type: "r" },
      d6: { color: "b", type: "p" },
      f4: { color: "w", type: "p" },
    });
    const rookMoves = new Chess().moves({ square: "d4" });
    expect(rookMoves).toEqual(expect.arrayContaining(["d5", "d6", "c4", "e4"]));
    expect(rookMoves).not.toContain("d7");
    expect(rookMoves).not.toContain("g4");

    __setNextBoard({ d4: { color: "w", type: "b" } });
    expect(new Chess().moves({ square: "d4" })).toEqual(expect.arrayContaining(["e5", "f6", "c5", "e3"]));

    __setNextBoard({ d4: { color: "w", type: "q" } });
    expect(new Chess().moves({ square: "d4" })).toEqual(expect.arrayContaining(["d5", "e4", "e5", "c3"]));

    __setNextBoard({ d4: { color: "w", type: "k" } });
    expect(new Chess().moves({ square: "d4" })).toEqual(expect.arrayContaining(["d5", "e5", "e4", "c3"]));

    __setNextBoard({
      e4: { color: "w", type: "p" },
      d5: { color: "b", type: "p" },
      f5: { color: "w", type: "p" },
    });
    const whitePawnMoves = new Chess().moves({ square: "e4" });
    expect(whitePawnMoves).toEqual(expect.arrayContaining(["e5", "d5"]));
    expect(whitePawnMoves).not.toContain("f5");

    __setNextBoard({
      d5: { color: "b", type: "p" },
      e4: { color: "w", type: "p" },
      c4: { color: "b", type: "p" },
    }, "b");
    const blackPawnMoves = new Chess().moves({ square: "d5" });
    expect(blackPawnMoves).toEqual(expect.arrayContaining(["d4", "e4"]));
    expect(blackPawnMoves).not.toContain("c4");
  });

  it("mock chess verbose pawn moves include promotion choices", async () => {
    const { Chess, __setNextBoard } = await import("chess.js") as unknown as ChessMockControls;

    __setNextBoard({ a7: { color: "w", type: "p" } });
    const moves = new Chess().moves({ square: "a7", verbose: true });

    expect(moves.filter((move) => move.to === "a8").map((move) => move.promotion)).toEqual(["q", "r", "b", "n"]);
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

  it("toggles between two-player and vs-computer modes", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    // Defaults to two-player; computer options are hidden.
    expect(screen.queryByTestId("difficulty")).toBeNull();
    expect(screen.getByTestId("mode-two-player").getAttribute("aria-pressed")).toBe("true");

    // Switch to vs Computer — color + difficulty controls appear.
    await act(async () => {
      fireEvent.click(screen.getByTestId("mode-vs-computer"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("mode-vs-computer").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByTestId("difficulty")).toBeTruthy();
      expect(screen.getByTestId("color-white")).toBeTruthy();
      expect(screen.getByTestId("color-black")).toBeTruthy();
    });

    // Difficulty is selectable.
    await act(async () => {
      fireEvent.change(screen.getByTestId("difficulty"), { target: { value: "hard" } });
      await Promise.resolve();
    });
    expect((screen.getByTestId("difficulty") as HTMLSelectElement).value).toBe("hard");

    // Back to two-player hides the options again.
    await act(async () => {
      fireEvent.click(screen.getByTestId("mode-two-player"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByTestId("difficulty")).toBeNull());
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

  it("Undo restores the previous board position", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-e4"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("square-e4").getAttribute("aria-label")).toBe("e4 White p");
    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    await waitFor(() => {
      expect(screen.getByTestId("square-e2").getAttribute("aria-label")).toBe("e2 White p");
      expect(screen.getByTestId("square-e4").getAttribute("aria-label")).toBe("e4 empty");
    });
  });

  it("keeps undo disabled while a promotion choice is pending", async () => {
    installMatrixDb([]);
    const { __setNextBoard } = await import("chess.js") as unknown as ChessMockControls;
    __setNextBoard({
      a7: { color: "w", type: "p" },
      g1: { color: "w", type: "n" },
      h7: { color: "b", type: "p" },
    });
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-g1"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-f3"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-h7"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-h6"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-a7"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-a8"));
      await Promise.resolve();
    });

    expect(screen.getByRole("dialog", { name: /choose promotion piece/i })).toBeTruthy();
    const undoButton = screen.getByRole("button", { name: /undo/i }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(true);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });

    expect(screen.getByRole("dialog", { name: /choose promotion piece/i })).toBeTruthy();
    expect(within(screen.getByTestId("move-history")).getByText("Nf3")).toBeTruthy();
    expect(within(screen.getByTestId("move-history")).getByText("h6")).toBeTruthy();
  });

  it("renders the selected piece after a pawn promotion", async () => {
    installMatrixDb([]);
    const { __setNextBoard } = await import("chess.js") as unknown as ChessMockControls;
    __setNextBoard({
      a7: { color: "w", type: "p" },
      g1: { color: "w", type: "n" },
      h7: { color: "b", type: "p" },
    });
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-g1"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-f3"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-h7"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-h6"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-a7"));
      await Promise.resolve();
      fireEvent.click(screen.getByTestId("square-a8"));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByTestId("promote-q"));

    await waitFor(() => {
      expect(screen.getByTestId("square-a8").getAttribute("aria-label")).toBe("a8 White q");
    });
  });

  it("falls back to local play when the computer search fails", async () => {
    installMatrixDb([]);
    vi.mocked(findBestMove).mockImplementationOnce(() => {
      throw new Error("engine down");
    });
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("mode-vs-computer"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e4"));
      await new Promise((resolve) => setTimeout(resolve, 260));
    });

    await waitFor(() => {
      expect(vi.mocked(findBestMove)).toHaveBeenCalled();
      expect(screen.getByTestId("mode-two-player").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByText("The computer could not find a move. Continuing as local two-player.")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e7"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("square-e6").getAttribute("data-legal")).toBe("true");
    });
  });

  it("falls back to local play when the computer returns no move", async () => {
    installMatrixDb([]);
    vi.mocked(findBestMove).mockReturnValueOnce(null);
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.click(screen.getByTestId("mode-vs-computer"));
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e2"));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e4"));
      await new Promise((resolve) => setTimeout(resolve, 260));
    });

    await waitFor(() => {
      expect(vi.mocked(findBestMove)).toHaveBeenCalled();
      expect(screen.getByTestId("mode-two-player").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByText("The computer could not find a move. Continuing as local two-player.")).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("square-e7"));
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen.getByTestId("square-e6").getAttribute("data-legal")).toBe("true");
    });
  });
});
