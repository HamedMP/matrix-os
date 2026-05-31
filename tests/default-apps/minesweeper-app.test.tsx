// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/games/minesweeper/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "time-new" })),
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

describe("Minesweeper app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    try {
      window.localStorage.clear();
    } catch {
      /* jsdom localStorage may be unavailable */
    }
  });

  it("renders the grid, mine counter, timer, and difficulty controls", async () => {
    installMatrixDb([]);
    render(<App />);

    // Beginner default: 9x9 = 81 cells.
    const cells = await screen.findAllByTestId(/^cell-/);
    expect(cells.length).toBe(81);

    // Mine counter shows 010 (3-digit Windows style) and timer 000.
    expect(screen.getByTestId("mine-counter").textContent).toBe("010");
    expect(screen.getByTestId("timer").textContent).toBe("000");

    // Smiley reset is present.
    expect(screen.getByTestId("reset")).toBeTruthy();
  });

  it("reveals a cell on left-click and starts play", async () => {
    installMatrixDb([]);
    render(<App />);
    const cells = await screen.findAllByTestId(/^cell-/);

    fireEvent.click(screen.getByTestId("cell-40")); // center-ish 9x9

    const revealed = (await screen.findAllByTestId(/^cell-/)).filter((el) =>
      el.getAttribute("data-state") === "revealed",
    );
    expect(revealed.length).toBeGreaterThan(0);
  });

  it("toggles a flag on right-click and updates the mine counter", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);

    const cell = screen.getByTestId("cell-0");
    fireEvent.contextMenu(cell);

    expect(screen.getByTestId("cell-0").getAttribute("data-state")).toBe("flagged");
    // 10 mines - 1 flag = 9
    expect(screen.getByTestId("mine-counter").textContent).toBe("009");

    // Right-click again removes it.
    fireEvent.contextMenu(screen.getByTestId("cell-0"));
    expect(screen.getByTestId("cell-0").getAttribute("data-state")).toBe("hidden");
    expect(screen.getByTestId("mine-counter").textContent).toBe("010");
  });

  it("loads best times from the Matrix DB on mount", async () => {
    const db = installMatrixDb([
      { id: "t1", difficulty: "beginner", seconds: 42, created_at: "2026-05-31T10:00:00.000Z" },
    ]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);
    expect(db.find).toHaveBeenCalledWith("times", expect.any(Object));
    const best = await screen.findByTestId("best-time");
    expect(within(best).getByText(/42/)).toBeTruthy();
  });

  it("falls back to localStorage when the DB bridge is unavailable", async () => {
    // No MatrixOS injected.
    render(<App />);
    const cells = await screen.findAllByTestId(/^cell-/);
    expect(cells.length).toBe(81);
    // Should not crash; mine counter still renders.
    expect(screen.getByTestId("mine-counter").textContent).toBe("010");
  });
});
