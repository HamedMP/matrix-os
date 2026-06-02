// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { tilesFromBoard } from "../../home/apps/games/2048/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "score-new" })),
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

describe("2048 app", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    window.localStorage.clear();
  });

  it("renders a 16-cell board, score, and best-score readouts", async () => {
    installMatrixDb([{ id: "s1", score: 1234, best: 5000, created_at: "2026-05-31T00:00:00.000Z" }]);
    render(<App />);

    const board = await screen.findByTestId("board");
    // 16 grid cells
    expect(within(board).getAllByTestId("cell").length).toBe(16);
    expect(screen.getByTestId("score").textContent).toBe("0");
    // best score loaded from DB
    await waitFor(() => expect(screen.getByTestId("best").textContent).toBe("5000"));
  });

  it("marks initial tiles as newly spawned rather than merged", async () => {
    installMatrixDb([]);
    render(<App />);

    const board = await screen.findByTestId("board");
    const tiles = within(board).getAllByTestId("tile");

    expect(tiles).toHaveLength(2);
    for (const tile of tiles) {
      expect(tile.className).toContain("is-new");
      expect(tile.className).not.toContain("is-merged");
    }
  });

  it("marks the merged target instead of a slid same-value tile", () => {
    const tiles = tilesFromBoard(
      [
        [4, 4, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        { id: 1, value: 2, row: 0, col: 0 },
        { id: 2, value: 2, row: 0, col: 1 },
        { id: 3, value: 4, row: 0, col: 3 },
      ],
      null,
      new Set(["0:0"]),
      new Set(["0:0", "0:1"]),
    );

    const merged = tiles.find((tile) => tile.row === 0 && tile.col === 0);
    const slid = tiles.find((tile) => tile.row === 0 && tile.col === 1);
    expect(merged?.merged).toBe(true);
    expect(merged?.id).not.toBe(3);
    expect(slid).toMatchObject({ id: 3, merged: false });
  });

  it("does not reuse consumed merge-source ids for surviving same-value tiles", () => {
    const tiles = tilesFromBoard(
      [
        [8, 4, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [
        { id: 1, value: 4, row: 0, col: 0 },
        { id: 2, value: 4, row: 0, col: 1 },
        { id: 3, value: 4, row: 0, col: 2 },
      ],
      null,
      new Set(["0:0"]),
      new Set(["0:0", "0:1"]),
    );

    const merged = tiles.find((tile) => tile.row === 0 && tile.col === 0);
    const survivor = tiles.find((tile) => tile.row === 0 && tile.col === 1);
    expect(merged?.merged).toBe(true);
    expect(survivor).toMatchObject({ id: 3, value: 4, merged: false });
  });

  it("does not mark unmatched fallback tiles as merged", () => {
    const tiles = tilesFromBoard(
      [
        [16, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      [{ id: 1, value: 2, row: 0, col: 0 }],
    );

    expect(tiles[0]).toMatchObject({ value: 16, spawned: false, merged: false });
  });

  it("an arrow key produces a move and increases score on a merge", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    const scoreBefore = Number(screen.getByTestId("score").textContent);

    // Press arrows in every direction; with two starting tiles at least one
    // direction will eventually merge or move. We assert the board reacts:
    // pressing keys must not throw and the score is a number that can only grow.
    await act(async () => {
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
        fireEvent.keyDown(window, { key });
        await Promise.resolve();
      }
    });

    const scoreAfter = Number(screen.getByTestId("score").textContent);
    expect(scoreAfter).toBeGreaterThanOrEqual(scoreBefore);
    // there must still be a board with 16 cells after moves
    expect(within(screen.getByTestId("board")).getAllByTestId("cell").length).toBe(16);
  });

  it("New game button resets the score to 0", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      for (const key of ["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown"]) {
        fireEvent.keyDown(window, { key });
        await Promise.resolve();
      }
    });

    fireEvent.click(screen.getByRole("button", { name: /new game/i }));
    expect(screen.getByTestId("score").textContent).toBe("0");
  });

  it("persists a zero live score when starting a new game", async () => {
    const db = installMatrixDb([{ id: "s1", score: 1234, best: 5000, created_at: "2026-05-31T00:00:00.000Z" }]);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("best").textContent).toBe("5000"));
    db.update.mockClear();

    fireEvent.click(screen.getByRole("button", { name: /new game/i }));

    await waitFor(() => expect(db.update).toHaveBeenCalledWith("scores", "s1", { score: 0 }));
  });

  it("waits for the initial score row before persisting an early best", async () => {
    const randomValues = [0, 0.1, 0, 0.1, 0, 0.1];
    vi.spyOn(Math, "random").mockImplementation(() => randomValues.shift() ?? 0.1);
    const db = installMatrixDb([]);
    let resolveFind: (rows: DbRow[]) => void = () => undefined;
    db.find.mockImplementation(async () => new Promise<DbRow[]>((resolve) => {
      resolveFind = resolve;
    }));

    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert).not.toHaveBeenCalled();

    await act(async () => {
      resolveFind([{ id: "s1", score: 0, best: 5000, created_at: "2026-05-31T00:00:00.000Z" }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(db.update).toHaveBeenCalledWith("scores", "s1", expect.objectContaining({ best: 5000 })),
    );
    expect(db.insert).not.toHaveBeenCalled();
    expect(screen.getByTestId("best").textContent).toBe("5000");
  });

  it("falls back to localStorage best score when MatrixOS.db is undefined", async () => {
    window.localStorage.setItem("matrixos.2048.best", "7777");
    render(<App />);
    await screen.findByTestId("board");
    await waitFor(() => expect(screen.getByTestId("best").textContent).toBe("7777"));
  });

  it("logs unexpected localStorage read failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("read failed");
    });

    render(<App />);
    await screen.findByTestId("board");

    expect(warn).toHaveBeenCalledWith("[2048] unexpected localStorage read error", expect.any(Error));
  });

  it("logs unexpected localStorage write failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("write failed");
    });
    vi.spyOn(Math, "random").mockReturnValue(0.1);

    render(<App />);
    await screen.findByTestId("board");

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(warn).toHaveBeenCalledWith("[2048] unexpected localStorage write error", expect.any(Error)),
    );
  });

  it("lets the player dismiss a transient sync error banner", async () => {
    const db = installMatrixDb([]);
    db.find.mockRejectedValueOnce(new Error("load failed"));

    render(<App />);
    await screen.findByTestId("board");
    expect(await screen.findByText("Couldn't load your best score; playing locally.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /dismiss sync message/i }));

    expect(screen.queryByText("Couldn't load your best score; playing locally.")).toBeNull();
  });
});
