// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/calculator/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const store = [...rows];
  const listeners = new Set<() => void>();
  const db = {
    find: vi.fn(async (_table: string, opts?: { orderBy?: Record<string, "asc" | "desc">; limit?: number }) => {
      const ordered = [...store].sort((a, b) => {
        const aTime = String(a.created_at ?? "");
        const bTime = String(b.created_at ?? "");
        return opts?.orderBy?.created_at === "asc" ? aTime.localeCompare(bTime) : bTime.localeCompare(aTime);
      });
      return typeof opts?.limit === "number" ? ordered.slice(0, opts.limit) : ordered;
    }),
    findOne: vi.fn(async (_t: string, id: string) => store.find((r) => r.id === id) ?? null),
    insert: vi.fn(async (_t: string, data: DbRow) => {
      const id = `new-${store.length + 1}`;
      store.push({ id, created_at: new Date().toISOString(), ...data });
      return { id };
    }),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async (_t: string, id: string) => {
      const idx = store.findIndex((r) => r.id === id);
      if (idx >= 0) store.splice(idx, 1);
      return { ok: true };
    }),
    count: vi.fn(async () => store.length),
    onChange: vi.fn((_table: string, listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
    emitChange: () => {
      for (const listener of listeners) listener();
    },
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: { db } });
  return db;
}

describe("Calculator app", () => {
  beforeEach(() => {
    if (!window.matchMedia) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
      });
    }
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(async () => undefined) },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("renders the expression input", async () => {
    installMatrixDb([]);
    render(<App />);
    expect(await screen.findByTestId("calc-input")).toBeTruthy();
  });

  it("evaluates as you type and shows the live result", async () => {
    installMatrixDb([]);
    render(<App />);
    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "2 + 3 * 4" } });
    const live = await screen.findByTestId("live-result");
    expect(live.textContent).toBe("14");
  });

  it("typing an expression + Enter persists via db.insert and renders in history", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6 * 7" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(db.insert).toHaveBeenCalledWith(
        "history",
        expect.objectContaining({
          expression: "6 * 7",
          result: "42",
          created_at: expect.any(String),
        }),
      );
    });
    const historyRail = await screen.findByTestId("history-rail");
    expect(historyRail.textContent).toContain("6 * 7");
    expect(historyRail.textContent).toContain("42");
  });

  it("keeps large carried results precise when committing again", async () => {
    const db = installMatrixDb([]);
    render(<App />);
    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1234567890123456" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() => expect(db.insert).toHaveBeenCalledTimes(1));
    expect(input.value).toBe("1234567890123456");

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.insert).toHaveBeenLastCalledWith(
        "history",
        expect.objectContaining({
          expression: "1234567890123456",
          result: "1.234568e+15",
        }),
      );
    });
  });

  it("removes the optimistic history row when db insert fails", async () => {
    const db = installMatrixDb([]);
    db.insert.mockRejectedValueOnce(new Error("insert failed"));
    render(<App />);
    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6 * 7" } });

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });

    expect(await screen.findByText("Result could not be saved.")).toBeTruthy();
    const historyRail = await screen.findByTestId("history-rail");
    expect(historyRail.textContent).not.toContain("6 * 7");
    expect(historyRail.textContent).not.toContain("42");
  });

  it("loads existing history from the database", async () => {
    installMatrixDb([
      { id: "h1", expression: "1 + 1", result: "2", created_at: "2026-05-31T10:00:00.000Z" },
    ]);
    render(<App />);
    const rail = await screen.findByTestId("history-rail");
    await waitFor(() => expect(rail.textContent).toContain("1 + 1"));
    expect(rail.textContent).toContain("2");
  });

  it("clears every persisted history row, not just the loaded page", async () => {
    const rows = Array.from({ length: 150 }, (_, index) => ({
      id: `h${index}`,
      expression: `${index} + 1`,
      result: String(index + 1),
      created_at: `2026-05-31T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
    }));
    const db = installMatrixDb(rows);
    localStorage.setItem("matrixos.calculator.history.v1", JSON.stringify(rows.slice(0, 2)));
    render(<App />);

    await screen.findByText("Clear");
    const clearHistory = screen
      .getAllByRole("button", { name: /clear/i })
      .find((button) => button.textContent?.includes("Clear"));
    expect(clearHistory).toBeTruthy();
    fireEvent.click(clearHistory!);

    await waitFor(() => {
      expect(db.delete).toHaveBeenCalledTimes(150);
    });
    expect(localStorage.getItem("matrixos.calculator.history.v1")).toBe("[]");
  });

  it("reports incomplete clears when the pagination safety cap is exhausted", async () => {
    const db = installMatrixDb([
      { id: "seed", expression: "1 + 1", result: "2", created_at: "2026-05-31T10:00:00.000Z" },
    ]);
    render(<App />);

    await screen.findByText("Clear");
    let page = 0;
    db.find.mockImplementation(async (_table: string, opts?: { limit?: number }) => {
      if (opts?.limit === 1) {
        return [{ id: "remaining", expression: "left", result: "left", created_at: "2026-05-31T11:00:00.000Z" }];
      }
      const rows = Array.from({ length: 100 }, (_, index) => ({
        id: `bulk-${page}-${index}`,
        expression: `${page}-${index}`,
        result: String(index),
        created_at: `2026-05-31T10:${String(index % 60).padStart(2, "0")}:00.000Z`,
      }));
      page += 1;
      return rows;
    });
    db.delete.mockResolvedValue({ ok: true });
    const clearHistory = screen
      .getAllByRole("button", { name: /clear/i })
      .find((button) => button.textContent?.includes("Clear"));
    expect(clearHistory).toBeTruthy();
    fireEvent.click(clearHistory!);

    expect(await screen.findByText("History could not be cleared.")).toBeTruthy();
    expect(db.delete).toHaveBeenCalledTimes(100 * 100);
  });

  it("reports non-throwing delete failures without restoring attempted local fallback rows", async () => {
    const rows = [
      { id: "h1", expression: "9 + 1", result: "10", created_at: "2026-05-31T10:00:00.000Z" },
    ];
    const db = installMatrixDb(rows);
    db.delete.mockResolvedValueOnce({ ok: false });
    localStorage.setItem("matrixos.calculator.history.v1", JSON.stringify(rows));
    render(<App />);

    await screen.findByText("Clear");
    const clearHistory = screen
      .getAllByRole("button", { name: /clear/i })
      .find((button) => button.textContent?.includes("Clear"));
    expect(clearHistory).toBeTruthy();
    fireEvent.click(clearHistory!);

    expect(await screen.findByText("History could not be cleared.")).toBeTruthy();
    expect(localStorage.getItem("matrixos.calculator.history.v1")).toBe("[]");
    expect(screen.getByText("9 + 1")).toBeTruthy();
  });

  it("ignores a concurrent clear while deletion is already in flight", async () => {
    const rows = [
      { id: "h1", expression: "1 + 1", result: "2", created_at: "2026-05-31T10:00:00.000Z" },
      { id: "h2", expression: "2 + 2", result: "4", created_at: "2026-05-31T10:01:00.000Z" },
    ];
    const db = installMatrixDb(rows);
    render(<App />);

    await screen.findByText("Clear");
    const clearHistory = screen
      .getAllByRole("button", { name: /clear/i })
      .find((button) => button.textContent?.includes("Clear"));
    expect(clearHistory).toBeTruthy();

    fireEvent.click(clearHistory!);
    fireEvent.click(clearHistory!);

    await waitFor(() => {
      expect(db.delete).toHaveBeenCalledTimes(2);
    });
  });

  it("does not reload history from change events while clearing", async () => {
    const rows = [
      { id: "h1", expression: "1 + 1", result: "2", created_at: "2026-05-31T10:00:00.000Z" },
      { id: "h2", expression: "2 + 2", result: "4", created_at: "2026-05-31T10:01:00.000Z" },
    ];
    const db = installMatrixDb(rows);
    let resolveDelete: (() => void) | undefined;
    db.delete.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = () => resolve({ ok: true });
        }),
    );
    render(<App />);

    await screen.findByText("Clear");
    const clearHistory = screen
      .getAllByRole("button", { name: /clear/i })
      .find((button) => button.textContent?.includes("Clear"));
    expect(clearHistory).toBeTruthy();

    fireEvent.click(clearHistory!);
    await waitFor(() => expect(db.delete).toHaveBeenCalled());
    db.find.mockClear();
    act(() => db.emitChange());

    expect(db.find).not.toHaveBeenCalled();
    resolveDelete?.();
  });

  it("does not insert new history while clearing is in flight", async () => {
    const rows = [
      { id: "h1", expression: "1 + 1", result: "2", created_at: "2026-05-31T10:00:00.000Z" },
    ];
    const db = installMatrixDb(rows);
    let resolveDelete: (() => void) | undefined;
    db.delete.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDelete = () => resolve({ ok: true });
        }),
    );
    render(<App />);

    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6 * 7" } });
    await screen.findByText("Clear");
    const clearHistory = screen
      .getAllByRole("button", { name: /clear/i })
      .find((button) => button.textContent?.includes("Clear"));
    expect(clearHistory).toBeTruthy();

    fireEvent.click(clearHistory!);
    await waitFor(() => expect(db.delete).toHaveBeenCalled());
    db.insert.mockClear();
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });

    expect(db.insert).not.toHaveBeenCalled();
    expect(await screen.findByText("Wait for history to finish clearing.")).toBeTruthy();
    resolveDelete?.();
  });

  it("does not clear history while a result save is in flight", async () => {
    const rows = [
      { id: "h1", expression: "1 + 1", result: "2", created_at: "2026-05-31T10:00:00.000Z" },
    ];
    const db = installMatrixDb(rows);
    let resolveInsert: (() => void) | undefined;
    db.insert.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveInsert = () => resolve({ id: "new-2" });
        }),
    );
    render(<App />);

    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "6 * 7" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });
    await waitFor(() => expect(db.insert).toHaveBeenCalled());

    const clearHistory = screen
      .getAllByRole("button", { name: /clear/i })
      .find((button) => button.textContent?.includes("Clear"));
    expect(clearHistory).toBeTruthy();
    fireEvent.click(clearHistory!);

    expect(db.delete).not.toHaveBeenCalled();
    expect(await screen.findByText("Wait for result to finish saving.")).toBeTruthy();
    await act(async () => {
      resolveInsert?.();
      await Promise.resolve();
    });
  });

  it("shows an onboarding empty state when history is empty", async () => {
    installMatrixDb([]);
    render(<App />);
    expect(await screen.findByText(/no calculations yet/i)).toBeTruthy();
  });

  it("does not show an error label while typing a partial expression", async () => {
    installMatrixDb([]);
    render(<App />);
    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1 +" } });
    // live preview should be blank/neutral, never throwing
    expect(screen.queryByText("Error")).toBeNull();
  });

  it("clears the input with the clear control", async () => {
    installMatrixDb([]);
    render(<App />);
    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "123" } });
    expect(input.value).toBe("123");
    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    expect(input.value).toBe("");
  });

  it("works without MatrixOS.db (localStorage fallback) without crashing", async () => {
    render(<App />);
    const input = (await screen.findByTestId("calc-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9 - 4" } });
    expect((await screen.findByTestId("live-result")).textContent).toBe("5");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
      await Promise.resolve();
    });
    const rail = await screen.findByTestId("history-rail");
    await waitFor(() => expect(rail.textContent).toContain("9 - 4"));
  });

  it("clicking a keypad digit appends to the expression", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("calc-input");
    fireEvent.click(screen.getByRole("button", { name: "7" }));
    fireEvent.click(screen.getByRole("button", { name: "8" }));
    const input = screen.getByTestId("calc-input") as HTMLInputElement;
    expect(input.value).toBe("78");
  });

  it("toggles scientific mode to reveal function keys", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("calc-input");
    fireEvent.click(screen.getByRole("button", { name: /scientific/i }));
    expect(screen.getByRole("button", { name: /sin/i })).toBeTruthy();
  });

  it("inserts the e constant without colliding with scientific notation", async () => {
    installMatrixDb([]);
    render(<App />);
    await screen.findByTestId("calc-input");
    fireEvent.click(screen.getByRole("button", { name: "2" }));
    fireEvent.click(screen.getByRole("button", { name: /scientific/i }));
    fireEvent.click(screen.getByRole("button", { name: "e" }));

    const input = screen.getByTestId("calc-input") as HTMLInputElement;
    const live = await screen.findByTestId("live-result");
    expect(input.value).toBe("2* e");
    expect(Number(live.textContent?.replace(/,/g, ""))).toBeCloseTo(2 * Math.E, 9);
  });

  it("marks the degree/radian toggle as pressed for assistive tech", async () => {
    installMatrixDb([]);
    render(<App />);
    const rad = await screen.findByRole("button", { name: "RAD" });
    expect(rad.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(rad);

    expect(screen.getByRole("button", { name: "DEG" }).getAttribute("aria-pressed")).toBe("true");
  });
});
