// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/expense-tracker/src/App";

type DbRow = Record<string, unknown>;

interface FakeDb {
  expenses: DbRow[];
  budgets: DbRow[];
  find: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  onChange: ReturnType<typeof vi.fn>;
}

function installMatrixDb(expenses: DbRow[] = [], budgets: DbRow[] = []): FakeDb {
  const state: FakeDb = {
    expenses: [...expenses],
    budgets: [...budgets],
    find: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    onChange: vi.fn(() => () => undefined),
  };
  state.find.mockImplementation(async (table: string) =>
    table === "budgets" ? state.budgets : state.expenses,
  );
  state.insert.mockImplementation(async (table: string, data: DbRow) => {
    const id = `${table}-${Math.random().toString(36).slice(2)}`;
    (table === "budgets" ? state.budgets : state.expenses).push({ id, created_at: new Date().toISOString(), ...data });
    return { id };
  });
  state.update.mockImplementation(async () => ({ ok: true }));
  state.delete.mockImplementation(async () => ({ ok: true }));

  Object.defineProperty(window, "MatrixOS", {
    configurable: true,
    value: { db: state },
  });
  return state;
}

// Build timestamps inside the CURRENT month so the app's default selected
// month (derived from the real clock) lines up with the fixtures.
const now = new Date();
const YM = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

function expense(day: number, amount: number, category: string, extra: DbRow = {}): DbRow {
  const stamp = `${YM}-${String(day).padStart(2, "0")}T10:00:00.000Z`;
  return {
    id: `e-${day}-${amount}-${category}`,
    amount,
    category,
    note: "",
    spent_at: stamp,
    recurring: false,
    created_at: stamp,
    ...extra,
  };
}

describe("Expense Tracker app", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("renders transactions from the database", async () => {
    installMatrixDb([
      expense(2, 42.5, "Groceries", { note: "Weekly shop" }),
      expense(4, 1200, "Rent"),
    ]);

    render(<App />);

    expect(await screen.findByText("Weekly shop")).toBeTruthy();
    expect(screen.getAllByText(/Groceries/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Rent/).length).toBeGreaterThan(0);
  });

  it("computes the monthly total in the KPI header", async () => {
    installMatrixDb([
      expense(2, 40, "Groceries"),
      expense(4, 60, "Rent"),
    ]);

    render(<App />);

    const total = await screen.findByTestId("kpi-total");
    expect(total.textContent).toMatch(/100\.00/);
  });

  it("renders a category breakdown", async () => {
    installMatrixDb([
      expense(2, 40, "Groceries"),
      expense(4, 60, "Rent"),
    ]);

    render(<App />);

    const breakdown = await screen.findByTestId("category-breakdown");
    expect(within(breakdown).getAllByText(/Rent/).length).toBeGreaterThan(0);
    expect(within(breakdown).getAllByText(/Groceries/).length).toBeGreaterThan(0);
  });

  it("shows an over-budget warning when spend exceeds the budget", async () => {
    installMatrixDb(
      [expense(2, 300, "Groceries")],
      [{ id: "b1", category: "Groceries", monthly_limit: 100 }],
    );

    render(<App />);

    expect(await screen.findByTestId("over-budget-warning")).toBeTruthy();
  });

  it("adds a transaction by calling db.insert with the right args", async () => {
    const db = installMatrixDb([], []);

    render(<App />);

    // wait for initial load to settle
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "25.50" } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "Coffee beans" } });

    await act(async () => {
      fireEvent.submit(screen.getByTestId("expense-form"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.insert).toHaveBeenCalled();
    });
    const call = db.insert.mock.calls.find((c) => c[0] === "expenses");
    expect(call).toBeTruthy();
    expect(call?.[1]).toMatchObject({ amount: 25.5, note: "Coffee beans" });
    expect(typeof (call?.[1] as Record<string, unknown>).category).toBe("string");
    expect(typeof (call?.[1] as Record<string, unknown>).spent_at).toBe("string");
  });

  it("renders an empty state with onboarding when there are no transactions", async () => {
    installMatrixDb([], []);

    render(<App />);

    expect(await screen.findByTestId("empty-state")).toBeTruthy();
  });
});
