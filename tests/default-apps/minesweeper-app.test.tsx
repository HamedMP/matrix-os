// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/games/minesweeper/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const listeners: Record<string, Array<() => void>> = {};
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "time-new" })),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    count: vi.fn(async () => rows.length),
    onChange: vi.fn((table: string, callback: () => void) => {
      (listeners[table] ??= []).push(callback);
      return () => {
        listeners[table] = (listeners[table] ?? []).filter((listener) => listener !== callback);
      };
    }),
    emitChange: (table: string) => {
      for (const callback of listeners[table] ?? []) callback();
    },
  };
  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db },
  });
  return db;
}

describe("Minesweeper app", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    try {
      window.localStorage.clear();
    } catch {
      /* jsdom localStorage may be unavailable */
    }
  });

  it("uses the shipped shared game icon", () => {
    const manifestPath = resolve(process.cwd(), "home/apps/games/minesweeper/matrix.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { icon?: string };

    expect(manifest.icon).toBe("game-center");
    expect(existsSync(resolve(process.cwd(), "home/system/icons/game-center.png"))).toBe(true);
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

  it("keeps both-button chord intent when the right button is released first", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);

    const cell = screen.getByTestId("cell-0");
    fireEvent.mouseDown(cell, { button: 0 });
    fireEvent.mouseDown(cell, { button: 2 });
    fireEvent.mouseUp(cell, { button: 2 });
    fireEvent.mouseUp(cell, { button: 0 });
    fireEvent.click(cell);

    expect(screen.getByTestId("cell-0").getAttribute("data-state")).toBe("hidden");
  });

  it("reveals a cell on a short touch tap", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);

    const cell = screen.getByTestId("cell-40");
    fireEvent.touchStart(cell);
    fireEvent.touchEnd(cell);

    const revealed = (await screen.findAllByTestId(/^cell-/)).filter((el) =>
      el.getAttribute("data-state") === "revealed",
    );
    expect(revealed.length).toBeGreaterThan(0);
  });

  it("does not toggle a flag when a touch long press is canceled", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);
    vi.useFakeTimers();

    const cell = screen.getByTestId("cell-0");
    fireEvent.touchStart(cell);
    fireEvent.touchCancel(cell);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(screen.getByTestId("cell-0").getAttribute("data-state")).toBe("hidden");
    expect(screen.getByTestId("mine-counter").textContent).toBe("010");
  });

  it("loads best times from the Matrix DB on mount", async () => {
    const db = installMatrixDb([
      { id: "t1", difficulty: "beginner", seconds: 42, created_at: "2026-05-31T10:00:00.000Z" },
    ]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);
    expect(db.find).toHaveBeenCalledWith("times", { orderBy: { seconds: "asc" }, limit: 500 });
    const best = await screen.findByTestId("best-time");
    expect(within(best).getByText(/42/)).toBeTruthy();
  });

  it("keeps loaded best times when an onChange reload fails", async () => {
    const db = installMatrixDb([
      { id: "t1", difficulty: "beginner", seconds: 42, created_at: "2026-05-31T10:00:00.000Z" },
    ]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);
    const best = await screen.findByTestId("best-time");
    expect(within(best).getByText(/42/)).toBeTruthy();

    db.find.mockRejectedValueOnce(new Error("transient reload failure"));
    db.emitChange("times");

    expect(await screen.findByText("Could not load best times")).toBeTruthy();
    expect(within(best).getByText(/42/)).toBeTruthy();
  });

  it("keeps loaded best times when the DB bridge disappears before onChange", async () => {
    const db = installMatrixDb([
      { id: "t1", difficulty: "beginner", seconds: 42, created_at: "2026-05-31T10:00:00.000Z" },
    ]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);
    const best = await screen.findByTestId("best-time");
    expect(within(best).getByText(/42/)).toBeTruthy();

    Reflect.deleteProperty(window, "MatrixOS");
    db.emitChange("times");

    expect(within(best).getByText(/42/)).toBeTruthy();
  });

  it("does not keep an optimistic best time when DB sync is unavailable", async () => {
    render(<App />);
    await screen.findAllByTestId(/^cell-/);

    fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Mines"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /new game/i }));
    expect(await screen.findAllByTestId(/^cell-/)).toHaveLength(25);

    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    fireEvent.click(screen.getByTestId("cell-12"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });
    vi.useRealTimers();

    for (let index = 1; index < 25; index += 1) {
      fireEvent.click(screen.getByTestId(`cell-${index}`));
    }

    expect(screen.getByText(/Cleared! Best time sync unavailable/)).toBeTruthy();
    expect(within(screen.getByTestId("best-time")).getByText("—")).toBeTruthy();
  });

  it("surfaces stale best-time cleanup failures after saving", async () => {
    const db = installMatrixDb([]);
    db.find
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "old-best", difficulty: "custom", rows: 5, cols: 5, mines: 1, seconds: 20 },
      ]);
    db.delete.mockRejectedValueOnce(new Error("delete failed"));

    render(<App />);
    await screen.findAllByTestId(/^cell-/);

    fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Mines"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /new game/i }));
    expect(await screen.findAllByTestId(/^cell-/)).toHaveLength(25);

    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    fireEvent.click(screen.getByTestId("cell-12"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_000);
    });

    for (let index = 1; index < 25; index += 1) {
      fireEvent.click(screen.getByTestId(`cell-${index}`));
    }
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/Best time saved; cleanup pending/)).toBeTruthy();
    expect(db.delete).toHaveBeenCalledWith("times", "old-best");
    expect(within(screen.getByTestId("best-time")).getByText("1s")).toBeTruthy();
  });

  it("saves best time under the completed game key when difficulty changes after win", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    await screen.findAllByTestId(/^cell-/);

    fireEvent.click(screen.getByRole("tab", { name: "Custom" }));
    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Height"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Mines"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: /new game/i }));
    expect(await screen.findAllByTestId(/^cell-/)).toHaveLength(25);

    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    fireEvent.click(screen.getByTestId("cell-12"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    await act(async () => {
      for (let index = 1; index < 25; index += 1) {
        fireEvent.click(screen.getByTestId(`cell-${index}`));
      }
      fireEvent.click(screen.getByRole("tab", { name: "Beginner" }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert).toHaveBeenCalledWith(
      "times",
      expect.objectContaining({
        difficulty: "custom",
        rows: 5,
        cols: 5,
        mines: 1,
        seconds: expect.any(Number),
      }),
    );
  });

  it("works without a DB bridge", async () => {
    // No MatrixOS injected.
    render(<App />);
    const cells = await screen.findAllByTestId(/^cell-/);
    expect(cells.length).toBe(81);
    // Should not crash; mine counter still renders.
    expect(screen.getByTestId("mine-counter").textContent).toBe("010");
  });

  it("sets a native max for custom mine counts", async () => {
    installMatrixDb([]);
    render(<App />);

    fireEvent.click(screen.getByRole("tab", { name: "Custom" }));

    const mines = screen.getByLabelText("Mines");
    expect(mines.getAttribute("max")).toBe("247");

    fireEvent.change(screen.getByLabelText("Width"), { target: { value: "3" } });
    expect(mines.getAttribute("max")).toBe("71");
  });
});
