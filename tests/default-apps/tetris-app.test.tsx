// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/games/tetris/src/App";

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

  it("renders a 10x20 playfield and loads the best score from Matrix Postgres", async () => {
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
});
