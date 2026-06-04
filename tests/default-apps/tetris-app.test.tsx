// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { persistScore } from "../../home/apps/games/tetris/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async (_table: string, opts?: { orderBy?: Record<string, "asc" | "desc">; limit?: number }) => {
      let result = [...rows];
      if (opts?.orderBy?.score) {
        result = result.sort((a, b) => {
          const left = Number(a.score) || 0;
          const right = Number(b.score) || 0;
          return opts.orderBy?.score === "desc" ? right - left : left - right;
        });
      }
      return typeof opts?.limit === "number" ? result.slice(0, opts.limit) : result;
    }),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async (_table: string, data: DbRow) => {
      rows.push({ id: "score-new", ...data });
      return { id: "score-new" };
    }),
    update: vi.fn(async (_table: string, id: string, data: DbRow) => {
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, data);
      return { ok: true };
    }),
    delete: vi.fn(async (_table: string, id: string) => {
      const index = rows.findIndex((item) => item.id === id);
      if (index >= 0) rows.splice(index, 1);
      return { ok: true };
    }),
    count: vi.fn(async () => rows.length),
    onChange: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db },
  });
  return db;
}

describe("Tetris app", () => {
  beforeEach(() => {
    // Fake timers keep the gravity interval from firing async state updates
    // after a test finishes (which would log act() warnings).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // matchMedia is referenced for prefers-reduced-motion.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("uses the shipped shared game icon", () => {
    const repoRoot = join(__dirname, "..", "..");
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "home/apps/games/tetris/matrix.json"), "utf-8"),
    ) as { icon?: string };

    expect(manifest.icon).toBe("game-center");
    expect(existsSync(join(repoRoot, "home/system/icons/game-center.png"))).toBe(true);
  });

  it("renders a 10x20 playfield and loads the best score from Matrix Postgres", async () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const db = installMatrixDb([
      { id: "s1", score: 4200, lines: 12, level: 2, created_at: "2026-05-31T10:00:00.000Z" },
    ]);

    render(<App />);

    // The board renders 200 visible cells.
    const board = await screen.findByTestId("tetris-board");
    expect(within(board).getAllByTestId("tetris-cell")).toHaveLength(200);

    // Best score loaded from the DB is shown.
    expect(await screen.findByText(/4,?200/)).toBeTruthy();
    expect(db.find).toHaveBeenCalledWith("scores", expect.anything());
    expect(getItem).not.toHaveBeenCalled();
  });

  it("does not write localStorage when saving a score through Matrix Postgres", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const db = installMatrixDb([]);

    await persistScore({ score: 1600, lines: 4, level: 1 });

    expect(db.insert).toHaveBeenCalledWith("scores", expect.any(Object));
    expect(setItem).not.toHaveBeenCalled();
  });

  it("reuses the best score row instead of appending lower scores", async () => {
    const db = installMatrixDb([
      { id: "best", score: 3200, lines: 9, level: 2 },
      { id: "stale", score: 400, lines: 1, level: 1 },
    ]);

    await persistScore({ score: 1600, lines: 4, level: 1 });

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).toHaveBeenCalledWith("scores", "stale");
  });

  it("updates the singleton best score row when saving a higher score", async () => {
    const db = installMatrixDb([
      { id: "best", score: 3200, lines: 9, level: 2 },
      { id: "stale", score: 400, lines: 1, level: 1 },
    ]);

    await persistScore({ score: 6400, lines: 18, level: 3 });

    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).toHaveBeenCalledWith("scores", "best", {
      score: 6400,
      lines: 18,
      level: 3,
    });
    expect(db.delete).toHaveBeenCalledWith("scores", "stale");
  });

  it("does not fail score persistence when stale score cleanup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = installMatrixDb([
      { id: "best", score: 3200, lines: 9, level: 2 },
      { id: "stale", score: 400, lines: 1, level: 1 },
    ]);
    db.delete.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(persistScore({ score: 6400, lines: 18, level: 3 })).resolves.toBeUndefined();

    expect(db.update).toHaveBeenCalledWith("scores", "best", {
      score: 6400,
      lines: 18,
      level: 3,
    });
    expect(warn).toHaveBeenCalledWith("[tetris] stale score cleanup failed:", "cleanup failed");
  });

  it("shows a start overlay and begins the game when the player starts", async () => {
    installMatrixDb([]);
    render(<App />);

    const dialog = await screen.findByRole("dialog");
    const startBtn = within(dialog).getByRole("button", { name: /play|start/i });
    await act(async () => {
      fireEvent.click(startBtn);
      await Promise.resolve();
    });

    // After starting, the status should reflect a running game (score 0).
    expect(screen.getByTestId("tetris-score").textContent).toContain("0");
  });

  it("clears stale error banners when starting a new game", async () => {
    const db = installMatrixDb([]);
    db.find.mockRejectedValueOnce(new Error("load failed"));
    render(<App />);

    expect(await screen.findByText("High score history could not be loaded.")).toBeTruthy();
    const dialog = await screen.findByRole("dialog");
    const startBtn = within(dialog).getByRole("button", { name: /play|start/i });
    await act(async () => {
      fireEvent.click(startBtn);
      await Promise.resolve();
    });

    expect(screen.queryByText("High score history could not be loaded.")).toBeNull();
  });

  it("moves the active piece when an arrow key is pressed", async () => {
    installMatrixDb([]);
    vi.useFakeTimers();
    render(<App />);

    // Start the game from the overlay dialog.
    const dialog = screen.getByRole("dialog");
    const startBtn = within(dialog).getByRole("button", { name: /play|start/i });
    act(() => {
      fireEvent.click(startBtn);
    });

    // Capture which cells are occupied by the active piece before/after move.
    function activeCols(): number[] {
      const cells = screen.getAllByTestId("tetris-cell");
      return cells
        .map((el, i) => ({ i, active: el.getAttribute("data-active") === "true" }))
        .filter((c) => c.active)
        .map((c) => c.i % 10);
    }

    const before = activeCols();
    // At least part of the active piece is visible at the top of the field.
    expect(before.length).toBeGreaterThan(0);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    const after = activeCols();

    // Moving right shifts every visible active column by exactly +1.
    expect(after.length).toBe(before.length);
    expect([...after].sort()).toEqual([...before].map((c) => c + 1).sort());

    vi.useRealTimers();
  });

  it("resumes from the pause overlay without restarting the board", async () => {
    installMatrixDb([]);
    render(<App />);

    const startBtn = within(screen.getByRole("dialog")).getByRole("button", { name: /play|start/i });
    act(() => {
      fireEvent.click(startBtn);
      fireEvent.keyDown(window, { key: "ArrowRight" });
      fireEvent.keyDown(window, { key: "p" });
    });

    function activeCols(): number[] {
      return screen
        .getAllByTestId("tetris-cell")
        .map((el, i) => ({ i, active: el.getAttribute("data-active") === "true" }))
        .filter((c) => c.active)
        .map((c) => c.i % 10);
    }

    const pausedCols = activeCols();
    const resumeBtn = within(screen.getByRole("dialog", { name: /paused/i })).getByRole("button", { name: /resume/i });
    act(() => {
      fireEvent.click(resumeBtn);
    });

    expect(screen.queryByRole("dialog", { name: /paused/i })).toBeNull();
    expect(activeCols()).toEqual(pausedCols);
  });
});
