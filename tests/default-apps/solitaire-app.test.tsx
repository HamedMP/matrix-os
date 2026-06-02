// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/games/solitaire/src/App";
import { type GameState } from "../../home/apps/games/solitaire/src/solitaire-model";

type DbRow = Record<string, unknown>;

function installMatrixDb(
  rows: DbRow[] = [],
  bridge: { readData?: () => Promise<unknown>; writeData?: (key: string, value: unknown) => Promise<void> } = {},
) {
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
    value: { db, ...bridge },
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

function oneMoveFromWinState(): GameState {
  const suits = ["spades", "hearts", "diamonds", "clubs"] as const;
  const foundations = suits.map((suit) =>
    Array.from({ length: 13 }, (_, r) => ({ id: `${suit}-${r + 1}`, suit, rank: r + 1, faceUp: true })),
  );
  const last = foundations[3].pop()!;
  return {
    stock: [],
    waste: [last],
    foundations,
    tableau: [[], [], [], [], [], [], []],
    drawCount: 1,
    moves: 10,
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

  it("clicking an exposed Ace sends it to a foundation (a legal move)", async () => {
    installMatrixDb();
    render(<App initialState={seededState()} />);

    const aceCard = await screen.findByTestId("card-spades-1");
    expect(screen.getByTestId("waste").textContent).toContain("A");

    await act(async () => {
      fireEvent.click(aceCard);
      await Promise.resolve();
    });

    // The ace now lives in a foundation pile, not the waste.
    const foundations = screen.getAllByTestId("foundation");
    const inFoundation = foundations.some((f) => within(f).queryByTestId("card-spades-1"));
    expect(inFoundation).toBe(true);
  });

  it("records a single undo entry per committed move under StrictMode", async () => {
    installMatrixDb();
    render(
      <React.StrictMode>
        <App initialState={seededState()} />
      </React.StrictMode>,
    );

    await act(async () => {
      fireEvent.click(await screen.findByTestId("card-spades-1"));
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));

    expect(screen.getByTestId("waste").textContent).toContain("A");
    expect((screen.getByRole("button", { name: /undo/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not restart the current game when clicking the active draw mode", async () => {
    installMatrixDb();
    render(<App initialState={seededState()} />);
    expect(await screen.findByTestId("card-spades-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /draw 1/i }));

    expect(screen.getByTestId("waste").textContent).toContain("A");
    expect(screen.getByTestId("card-spades-1")).toBeTruthy();
  });

  it("changes draw mode without throwing when the bridge has no writeData helper", async () => {
    installMatrixDb();
    render(<App initialState={seededState()} />);
    expect(await screen.findByTestId("card-spades-1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /draw 3/i }));

    expect(screen.getByRole("button", { name: /draw 3/i }).className).toContain("seg--on");
    expect(screen.queryByText(/draw preference save failed/i)).toBeNull();
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

  it("shows when a foundation card is selected", async () => {
    installMatrixDb();
    const state: GameState = {
      stock: [],
      waste: [],
      foundations: [
        [{ id: "hearts-13", suit: "hearts", rank: 13, faceUp: true }],
        [],
        [],
        [],
      ],
      tableau: [[], [], [], [], [], [], []],
      drawCount: 1,
      moves: 0,
      score: 0,
    };
    render(<App initialState={state} />);

    const card = await screen.findByTestId("card-hearts-13");
    fireEvent.click(card);

    expect(card.className).toContain("sol-card--selected");
  });

  it("applies saved draw-three preference to the untouched initial deal", async () => {
    installMatrixDb([], { readData: vi.fn(async () => 3) });
    render(<App />);

    const drawThree = await screen.findByRole("button", { name: /draw 3/i });
    await waitFor(() => expect(drawThree.className).toContain("seg--on"));

    await act(async () => {
      fireEvent.click(screen.getByTestId("stock"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("stock").textContent).toContain("21");
  });

  it("does not double-count when a new game starts before stats finish loading", async () => {
    let resolveFind: (rows: DbRow[]) => void = () => undefined;
    const db = installMatrixDb();
    db.find.mockImplementation(async () => new Promise<DbRow[]>((resolve) => {
      resolveFind = resolve;
    }));

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /new game/i }));

    await act(async () => {
      resolveFind([{ id: "stats-1", games_played: 5, games_won: 2, best_time: 90, best_moves: 30 }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(db.update).toHaveBeenCalledWith(
      "stats",
      "stats-1",
      expect.objectContaining({ games_played: 6 }),
    ));
    expect(db.update.mock.calls.filter((call) => call[0] === "stats" && (call[2] as DbRow).games_played === 6)).toHaveLength(1);
    expect(db.update.mock.calls.filter((call) => call[0] === "stats" && (call[2] as DbRow).games_played === 7)).toHaveLength(0);
  });

  it("does not auto-route a waste card while another source is selected", async () => {
    installMatrixDb();
    const state: GameState = {
      ...seededState(),
      tableau: [
        [{ id: "spades-5", suit: "spades", rank: 5, faceUp: true }],
        [],
        [],
        [],
        [],
        [],
        [],
      ],
    };
    render(<App initialState={state} />);

    fireEvent.click(await screen.findByTestId("card-spades-5"));
    fireEvent.click(screen.getByTestId("card-spades-1"));

    expect(screen.getByTestId("waste").textContent).toContain("A");
    expect(screen.getAllByTestId("foundation").some((pile) => within(pile).queryByTestId("card-spades-1"))).toBe(false);
    expect(screen.getByTestId("card-spades-1").className).toContain("sol-card--selected");
  });

  it("persists stats to the bridge when a game is won", async () => {
    const db = installMatrixDb([]);
    render(<App initialState={oneMoveFromWinState()} />);

    const kingCard = await screen.findByTestId("card-clubs-13");
    await act(async () => {
      fireEvent.click(kingCard);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("win-banner")).toBeTruthy();
    await waitFor(() => {
      const statPayloads = [
        ...db.insert.mock.calls.filter((call) => call[0] === "stats").map((call) => call[1] as DbRow),
        ...db.update.mock.calls.filter((call) => call[0] === "stats").map((call) => call[2] as DbRow),
      ];
      expect(statPayloads).toContainEqual(expect.objectContaining({
        games_won: 1,
        best_moves: 11,
      }));
    });
  });

  it("preserves queued win and new-game stats when bridge updates resolve slowly", async () => {
    const db = installMatrixDb([{ id: "stats-1", games_played: 5, games_won: 0, best_time: 0, best_moves: 0 }]);
    const payloads: DbRow[] = [];
    const releaseUpdates: Array<() => void> = [];
    db.update.mockImplementation(async (_table: string, _id: string, payload: DbRow) => {
      payloads.push(payload);
      await new Promise<void>((resolve) => {
        releaseUpdates.push(resolve);
      });
      return { ok: true };
    });

    render(<App initialState={oneMoveFromWinState()} />);
    await screen.findByTestId("card-clubs-13");

    await act(async () => {
      fireEvent.click(await screen.findByTestId("card-clubs-13"));
      await Promise.resolve();
      fireEvent.click(screen.getByRole("button", { name: /new game/i }));
      await Promise.resolve();
    });

    expect(payloads).toHaveLength(1);

    for (let i = 0; i < 2; i += 1) {
      await waitFor(() => expect(releaseUpdates.length).toBeGreaterThan(0));
      const release = releaseUpdates.shift();
      expect(release).toBeDefined();
      await act(async () => {
        release?.();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(payloads).toContainEqual(expect.objectContaining({ games_played: 5, games_won: 1, best_moves: 11 }));
    expect(payloads).toContainEqual(expect.objectContaining({ games_played: 6, games_won: 1 }));
  });

  it("records a second win after undoing from a won game", async () => {
    const db = installMatrixDb([]);
    render(<App initialState={oneMoveFromWinState()} />);

    await act(async () => {
      fireEvent.click(await screen.findByTestId("card-clubs-13"));
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      const statPayloads = [
        ...db.insert.mock.calls.filter((call) => call[0] === "stats").map((call) => call[1] as DbRow),
        ...db.update.mock.calls.filter((call) => call[0] === "stats").map((call) => call[2] as DbRow),
      ];
      expect(statPayloads).toContainEqual(expect.objectContaining({ games_won: 1 }));
    });

    fireEvent.click(screen.getByRole("button", { name: /undo/i }));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(await screen.findByTestId("card-clubs-13"));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => {
      const statPayloads = [
        ...db.insert.mock.calls.filter((call) => call[0] === "stats").map((call) => call[1] as DbRow),
        ...db.update.mock.calls.filter((call) => call[0] === "stats").map((call) => call[2] as DbRow),
      ];
      expect(statPayloads).toContainEqual(expect.objectContaining({ games_won: 2 }));
    });
  });
});
