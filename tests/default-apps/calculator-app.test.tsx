// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/calculator/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const store = [...rows];
  const db = {
    find: vi.fn(async () => [...store].reverse()),
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
    onChange: vi.fn(() => () => undefined),
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
        expect.objectContaining({ expression: "6 * 7", result: "42" }),
      );
    });
    const historyRail = await screen.findByTestId("history-rail");
    expect(historyRail.textContent).toContain("6 * 7");
    expect(historyRail.textContent).toContain("42");
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
});
