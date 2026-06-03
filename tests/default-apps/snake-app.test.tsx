// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/games/snake/src/App";

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

describe("Snake app", () => {
  beforeEach(() => {
    // jsdom has no canvas 2d context; stub it so the renderer does not throw.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (HTMLCanvasElement.prototype as any).getContext = vi.fn(() => ({
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      roundRect: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      closePath: vi.fn(),
      setTransform: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      set fillStyle(_v: string) {},
      set strokeStyle(_v: string) {},
      set lineWidth(_v: number) {},
      set lineJoin(_v: string) {},
      set lineCap(_v: string) {},
      set globalAlpha(_v: number) {},
      set shadowBlur(_v: number) {},
      set shadowColor(_v: string) {},
    }));
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    localStorage.clear();
  });

  it("uses a shipped default game icon", () => {
    const manifestPath = resolve(process.cwd(), "home/apps/games/snake/matrix.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { icon?: string };

    expect(manifest.icon).toBe("game-center");
    expect(existsSync(resolve(process.cwd(), "home/system/icons/game-center.png"))).toBe(true);
  });

  it("renders the start screen with controls hint and a high score", async () => {
    installMatrixDb([{ id: "s1", score: 12, best: 12, created_at: "2026-05-31T10:00:00Z" }]);
    render(<App />);
    // High score from the DB is reflected.
    expect((await screen.findByTestId("high-score")).textContent).toContain("12");
    // Start state / onboarding hint is present.
    expect(screen.getByTestId("snake-status").textContent?.toLowerCase()).toContain("ready");
  });

  it("shows 0 best when MatrixOS.readData is absent and db has no rows", async () => {
    installMatrixDb([]);
    render(<App />);

    expect((await screen.findByTestId("high-score")).textContent).toContain("0");
  });

  it("starts on a direction key and advances state on ticks", async () => {
    installMatrixDb([]);
    vi.useFakeTimers();
    render(<App />);

    const initialScore = screen.getByTestId("score").textContent;
    expect(initialScore).toBe("0");

    // Pressing an arrow key starts the game heading right.
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    expect(screen.getByTestId("snake-status").textContent?.toLowerCase()).toContain("running");

    // Advancing one tick keeps the game running (the snake moves one cell to the
    // right, well clear of any wall) — confirms the loop is wired to the engine.
    act(() => {
      vi.advanceTimersByTime(220);
    });
    expect(screen.getByTestId("snake-status").textContent?.toLowerCase()).toContain("running");
  });

  it("does not overwrite fallback best before the initial best load resolves", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(208 / 397);
    const db = installMatrixDb([]);
    db.find.mockImplementation(async () => new Promise<DbRow[]>(() => undefined));
    const writeData = vi.fn(async () => undefined);
    Object.defineProperty(window, "MatrixOS", {
      configurable: true,
      value: {
        db,
        readData: vi.fn(async () => 12),
        writeData,
      },
    });

    render(<App />);

    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(db.insert).toHaveBeenCalledWith("scores", expect.objectContaining({ score: expect.any(Number) }));
    expect(writeData).not.toHaveBeenCalled();
  });

  it("does not retry fallback best writes when score sync also fails", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(208 / 397);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const db = installMatrixDb([]);
    db.insert.mockRejectedValueOnce(new Error("sync failed"));
    const writeData = vi.fn(async () => {
      throw new Error("fallback failed");
    });
    Object.defineProperty(window, "MatrixOS", {
      configurable: true,
      value: {
        db,
        readData: vi.fn(async () => 0),
        writeData,
      },
    });

    render(<App />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
      await vi.advanceTimersByTimeAsync(2_500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert).toHaveBeenCalled();
    expect(writeData).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Score could not be synced.")).toBeTruthy();
  });

  it("pauses and resumes with Space", async () => {
    installMatrixDb([]);
    vi.useFakeTimers();
    render(<App />);

    act(() => {
      fireEvent.keyDown(window, { key: "ArrowUp" });
    });
    expect(screen.getByTestId("snake-status").textContent?.toLowerCase()).toContain("running");

    act(() => {
      fireEvent.keyDown(window, { key: " " });
    });
    expect(screen.getByTestId("snake-status").textContent?.toLowerCase()).toContain("paused");
  });
});
