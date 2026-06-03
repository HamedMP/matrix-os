// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { movesForTarget } from "../../home/apps/games/backgammon/src/App";
import { OFF, type Move } from "../../home/apps/games/backgammon/src/backgammon-model";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  let changeCallback: (() => void) | null = null;
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "match-new" })),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    count: vi.fn(async () => rows.length),
    onChange: vi.fn((_table: string, callback: () => void) => {
      changeCallback = callback;
      return () => {
        changeCallback = null;
      };
    }),
    triggerChange: () => changeCallback?.(),
  };
  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db },
  });
  return db;
}

describe("Backgammon app", () => {
  beforeEach(() => {
    // deterministic dice
    vi.spyOn(Math, "random").mockReturnValue(0); // floor(0*6)+1 = 1 for every die
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("renders the board with 24 points and turn/pip indicators", async () => {
    installMatrixDb([]);
    render(<App />);

    const board = await screen.findByTestId("board");
    expect(within(board).getAllByTestId(/^point-/).length).toBe(24);
    expect(screen.getByTestId("turn-indicator")).toBeTruthy();
    expect(screen.getByTestId("pip-white")).toBeTruthy();
    expect(screen.getByTestId("pip-black")).toBeTruthy();
  });

  it("rolls dice and lets a player make a legal checker move", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("board");

    // Roll: with Math.random -> 0 the dice are [1,1] (doubles, four 1s).
    fireEvent.click(screen.getByRole("button", { name: /roll/i }));

    await waitFor(() => expect(screen.getByTestId("dice")).toBeTruthy());

    // White starts; white's checkers are at 24,13,8,6. With die 1 white can move
    // 24->23, 13->12(black blot? no, 12 is black with 5 -> blocked), 8->7, 6->5.
    // Select point 24 (a movable white stack) then a highlighted destination.
    const p24 = screen.getByTestId("point-24");
    fireEvent.click(p24);

    // a legal destination must be highlighted; click the first highlighted target
    const target = await screen.findByTestId("point-23");
    expect(target.getAttribute("data-legal")).toBe("true");
    fireEvent.click(target);

    // after moving, point 23 should now hold a white checker
    await waitFor(() =>
      expect(screen.getByTestId("point-23").getAttribute("data-owner")).toBe("white"),
    );
  });

  it("keeps all legal die choices for an ambiguous bear off target", () => {
    const exact = { from: 3, to: OFF, die: 3, bearOff: true } satisfies Move;
    const overshoot = { from: 3, to: OFF, die: 6, bearOff: true } satisfies Move;

    expect(movesForTarget([exact, overshoot], OFF)).toEqual([exact, overshoot]);
  });

  it("renders without a DB bridge and leaves match history empty", async () => {
    render(<App />);
    await screen.findByTestId("board");
    expect(screen.getByTestId("match-count").textContent).toContain("0");
  });

  it("preserves match history when a live refresh fails", async () => {
    const db = installMatrixDb([{ winner: "white", points: 2 }]);
    render(<App />);

    await waitFor(() => expect(screen.getByTestId("match-count").textContent).toContain("1"));

    db.find.mockRejectedValueOnce(new Error("temporary storage failure"));
    await act(async () => {
      db.triggerChange();
    });

    await waitFor(() => expect(screen.getByText("Could not load match history.")).toBeTruthy());
    expect(screen.getByTestId("match-count").textContent).toContain("1");
  });
});
