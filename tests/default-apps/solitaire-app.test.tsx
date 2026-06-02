// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/games/solitaire/src/App";
import { type GameState } from "../../home/apps/games/solitaire/src/solitaire-model";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "stats-new" })),
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

// A state where the waste has an Ace ready to send to a foundation.
function seededState(): GameState {
  const t: GameState["tableau"] = [[], [], [], [], [], [], []];
  return {
    stock: [],
    waste: [{ id: "spades-1", suit: "spades", rank: 1, faceUp: true }],
    foundations: [[], [], [], []],
    tableau: t,
    drawCount: 1,
    moves: 0,
    score: 0,
  };
}

describe("Solitaire app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("renders the board with foundations, stock, and a new game control", async () => {
    installMatrixDb();
    render(<App />);
    expect(await screen.findByRole("button", { name: /new game/i })).toBeTruthy();
    // 4 foundation slots present
    expect(screen.getAllByTestId("foundation").length).toBe(4);
    // 7 tableau piles present
    expect(screen.getAllByTestId("tableau-pile").length).toBe(7);
  });

  it("double-clicking an exposed Ace sends it to a foundation (a legal move)", async () => {
    installMatrixDb();
    render(<App initialState={seededState()} />);

    const aceCard = await screen.findByTestId("card-spades-1");
    expect(screen.getByTestId("waste").textContent).toContain("A");

    await act(async () => {
      fireEvent.doubleClick(aceCard);
      await Promise.resolve();
    });

    // The ace now lives in a foundation pile, not the waste.
    const foundations = screen.getAllByTestId("foundation");
    const inFoundation = foundations.some((f) => within(f).queryByTestId("card-spades-1"));
    expect(inFoundation).toBe(true);
  });

  it("does not add undo history when drawing from empty stock and waste", async () => {
    installMatrixDb();
    render(<App initialState={{ ...seededState(), waste: [] }} />);

    const undoButton = await screen.findByRole("button", { name: /undo/i }) as HTMLButtonElement;
    expect(undoButton.disabled).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId("stock"));
      await Promise.resolve();
    });

    expect(undoButton.disabled).toBe(true);
  });

  it("clears a selected tableau card when it is clicked again", async () => {
    installMatrixDb();
    const state: GameState = {
      stock: [],
      waste: [],
      foundations: [[], [], [], []],
      tableau: [
        [{ id: "spades-5", suit: "spades", rank: 5, faceUp: true }],
        [],
        [],
        [],
        [],
        [],
        [],
      ],
      drawCount: 1,
      moves: 0,
      score: 0,
    };
    render(<App initialState={state} />);

    const card = await screen.findByTestId("card-spades-5");
    fireEvent.click(card);
    expect(card.className).toContain("sol-card--selected");

    fireEvent.click(card);
    expect(card.className).not.toContain("sol-card--selected");
  });

  it("persists stats to the bridge when a game is won", async () => {
    const db = installMatrixDb([]);
    // a state one move from a win: 51 cards on foundations, last Ace... build full minus one
    const suits = ["spades", "hearts", "diamonds", "clubs"] as const;
    const foundations = suits.map((suit) =>
      Array.from({ length: 13 }, (_, r) => ({ id: `${suit}-${r + 1}`, suit, rank: r + 1, faceUp: true })),
    );
    // remove the last card (clubs King) and place it on the waste
    const last = foundations[3].pop()!;
    const winState: GameState = {
      stock: [],
      waste: [last],
      foundations,
      tableau: [[], [], [], [], [], [], []],
      drawCount: 1,
      moves: 10,
      score: 0,
    };
    render(<App initialState={winState} />);

    const kingCard = await screen.findByTestId("card-clubs-13");
    await act(async () => {
      fireEvent.doubleClick(kingCard);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("win-banner")).toBeTruthy();
    expect(db.insert).toHaveBeenCalled();
    const tableArg = db.insert.mock.calls[0][0];
    expect(tableArg).toBe("stats");
  });
});
