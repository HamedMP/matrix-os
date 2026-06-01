// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/games/backgammon/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "match-new" })),
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

describe("Backgammon app", () => {
  beforeEach(() => {
    window.localStorage.clear();
    // deterministic dice
    vi.spyOn(Math, "random").mockReturnValue(0); // floor(0*6)+1 = 1 for every die
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    window.localStorage.clear();
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

  it("falls back to localStorage match record when MatrixOS.db is undefined", async () => {
    window.localStorage.setItem(
      "matrixos.backgammon.matches",
      JSON.stringify([{ winner: "white", points: 2 }]),
    );
    render(<App />);
    await screen.findByTestId("board");
    // the stored match should surface somewhere (records readout)
    await waitFor(() => expect(screen.getByTestId("match-count").textContent).toContain("1"));
  });
});
