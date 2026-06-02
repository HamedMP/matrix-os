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
  state.find.mockImplementation(
    async (table: string, opts?: { limit?: number; offset?: number; orderBy?: Record<string, "asc" | "desc"> }) => {
      let rows = table === "budgets" ? state.budgets : state.expenses;
      const orderEntry = Object.entries(opts?.orderBy ?? {})[0];
      if (orderEntry) {
        const [column, direction] = orderEntry;
        rows = [...rows].sort((a, b) =>
          direction === "desc"
            ? String(b[column] ?? "").localeCompare(String(a[column] ?? ""))
            : String(a[column] ?? "").localeCompare(String(b[column] ?? "")),
        );
      }
      const offset = opts?.offset ?? 0;
      return typeof opts?.limit === "number" ? rows.slice(offset, offset + opts.limit) : rows.slice(offset);
    },
  );
  state.insert.mockImplementation(async (table: string, data: DbRow) => {
    const id = `${table}-${Math.random().toString(36).slice(2)}`;
    (table === "budgets" ? state.budgets : state.expenses).push({ id, created_at: new Date().toISOString(), ...data });
    return { id };
  });
  state.update.mockImplementation(async (table: string, id: string, data: DbRow) => {
    const rows = table === "budgets" ? state.budgets : state.expenses;
    const row = rows.find((item) => item.id === id);
    if (row) Object.assign(row, data);
    return { ok: true };
  });
  state.delete.mockImplementation(async (table: string, id: string) => {
    const rows = table === "budgets" ? state.budgets : state.expenses;
    const idx = rows.findIndex((item) => item.id === id);
    if (idx >= 0) rows.splice(idx, 1);
    return { ok: true };
  });

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

function dateInputMonthsFromCurrent(monthOffset: number, day = 2): string {
  const [year, month] = YM.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1 + monthOffset, day));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function monthLabelForInput(value: string): string {
  return new Date(`${value.slice(0, 7)}-01T00:00:00.000Z`).toLocaleDateString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

describe("Expense Tracker app", () => {
  afterEach(() => {
    vi.useRealTimers();
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

  it("loads expenses beyond the first page", async () => {
    const rows = Array.from({ length: 501 }, (_, index) =>
      expense(2, index === 500 ? 75 : 1, index === 500 ? "Health" : "Other", {
        id: `expense-${index}`,
        spent_at: `${YM}-02T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const db = installMatrixDb(rows, []);

    render(<App />);

    await waitFor(() => {
      expect(db.find).toHaveBeenCalledWith(
        "expenses",
        expect.objectContaining({ limit: 500, offset: 500 }),
      );
    });
    expect((await screen.findByTestId("kpi-total")).textContent).toMatch(/575\.00/);
  });

  it("loads budgets beyond the first page", async () => {
    const budgets = Array.from({ length: 501 }, (_, index) => ({
      id: `budget-${index}`,
      category: `Category ${index}`,
      monthly_limit: index + 1,
    }));
    const db = installMatrixDb([], budgets);

    render(<App />);

    await waitFor(() => {
      expect(db.find).toHaveBeenCalledWith(
        "budgets",
        expect.objectContaining({ limit: 500, offset: 500 }),
      );
    });
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

  it("does not mark spending as over budget when no budget is configured", async () => {
    installMatrixDb([expense(2, 300, "Groceries")]);

    render(<App />);

    expect(await screen.findByText("Budget not set")).toBeTruthy();
    expect(screen.queryByText("Over budget")).toBeNull();
    expect(screen.queryByTestId("over-budget-warning")).toBeNull();
  });

  it("deduplicates existing budgets when saving the budget sheet", async () => {
    const db = installMatrixDb(
      [expense(2, 30, "Groceries")],
      [
        { id: "b1", category: "Groceries", monthly_limit: 100 },
        { id: "b2", category: "Groceries", monthly_limit: 125 },
      ],
    );

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /edit budgets/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith("budgets", "b1", { monthly_limit: 100 });
      expect(db.delete).toHaveBeenCalledWith("budgets", "b2");
    });
  });

  it("adds a transaction by calling db.insert with the right args", async () => {
    const db = installMatrixDb([], []);

    render(<App />);

    // wait for initial load to settle
    await act(async () => {
      await Promise.resolve();
    });

    const amountInput = screen.getByLabelText(/amount/i) as HTMLInputElement;
    expect(amountInput.min).toBe("0.01");
    expect(amountInput.step).toBe("0.01");
    fireEvent.change(amountInput, { target: { value: "25.50" } });
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

  it("defaults the expense date to the UTC day used by month selection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T01:00:00.000Z"));
    installMatrixDb([], []);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    const dateInput = screen.getByLabelText(/date/i) as HTMLInputElement;
    expect(dateInput.value).toBe("2026-05-01");
  });

  it("keeps an inserted transaction visible when the follow-up reload fails", async () => {
    const db = installMatrixDb([], []);

    render(<App />);
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "25.50" } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "Coffee beans" } });
    db.find.mockRejectedValueOnce(new Error("read failed"));

    await act(async () => {
      fireEvent.submit(screen.getByTestId("expense-form"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Coffee beans")).toBeTruthy();
    expect(screen.queryByText("Could not save that transaction.")).toBeNull();
  });

  it("restores the selected month after a failed transaction insert", async () => {
    const db = installMatrixDb([expense(2, 12, "Groceries", { note: "Coffee beans" })], []);
    db.insert.mockRejectedValueOnce(new Error("write failed"));

    render(<App />);
    expect(await screen.findByText("Coffee beans")).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: "25.50" } });
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: "Bad write" } });
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: "2000-01-02" } });

    await act(async () => {
      fireEvent.submit(screen.getByTestId("expense-form"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Could not save that transaction.")).toBeTruthy();
    expect(screen.getByText("Coffee beans")).toBeTruthy();
    expect(screen.queryByText("Bad write")).toBeNull();
  });

  it("keeps an edited transaction visible when its date moves to another month", async () => {
    const db = installMatrixDb([expense(2, 12, "Groceries", { note: "Coffee beans" })], []);
    const nextDate = dateInputMonthsFromCurrent(1);

    render(<App />);
    expect(await screen.findByText("Coffee beans")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /edit coffee beans/i }));
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: nextDate } });

    await act(async () => {
      fireEvent.submit(screen.getByTestId("expense-form"));
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(db.update).toHaveBeenCalledWith(
        "expenses",
        "e-2-12-Groceries",
        expect.objectContaining({ spent_at: `${nextDate}T00:00:00.000Z` }),
      );
    });
    expect(screen.getByTestId("selected-month").textContent).toBe(monthLabelForInput(nextDate));
    expect(screen.getByText("Coffee beans")).toBeTruthy();
  });

  it("restores the selected month after a failed transaction edit", async () => {
    const db = installMatrixDb([expense(2, 12, "Groceries", { note: "Coffee beans" })], []);
    const originalMonthLabel = monthLabelForInput(`${YM}-01`);
    db.update.mockRejectedValueOnce(new Error("write failed"));

    render(<App />);
    expect(await screen.findByText("Coffee beans")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /edit coffee beans/i }));
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: dateInputMonthsFromCurrent(1) } });

    await act(async () => {
      fireEvent.submit(screen.getByTestId("expense-form"));
      await Promise.resolve();
    });

    expect(await screen.findByText("Could not save that change.")).toBeTruthy();
    expect(screen.getByTestId("selected-month").textContent).toBe(originalMonthLabel);
    expect(screen.getByText("Coffee beans")).toBeTruthy();
  });

  it("keeps a deleted transaction hidden when the follow-up reload fails", async () => {
    const db = installMatrixDb([expense(2, 12, "Groceries", { note: "Coffee beans" })], []);

    render(<App />);
    expect(await screen.findByText("Coffee beans")).toBeTruthy();
    db.find.mockRejectedValueOnce(new Error("read failed"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /delete coffee beans/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.delete).toHaveBeenCalled();
    expect(screen.queryByText("Coffee beans")).toBeNull();
    expect(screen.queryByText("Could not delete that transaction.")).toBeNull();
  });

  it("does not reopen budget editing when the follow-up reload fails after a save", async () => {
    const db = installMatrixDb([], [{ id: "b1", category: "Groceries", monthly_limit: 100 }]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /edit budgets/i }));
    fireEvent.change(screen.getByLabelText("Groceries monthly budget"), { target: { value: "150" } });
    db.find.mockRejectedValueOnce(new Error("read failed"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith("budgets", "b1", { monthly_limit: 150 });
    expect(screen.queryByRole("dialog", { name: /edit budgets/i })).toBeNull();
    expect(screen.queryByText("Could not save your budgets.")).toBeNull();
  });

  it("dismisses budget editing with Escape and backdrop clicks", async () => {
    installMatrixDb([], [{ id: "b1", category: "Groceries", monthly_limit: 100 }]);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /edit budgets/i }));
    expect(screen.getByRole("dialog", { name: /edit budgets/i })).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /edit budgets/i })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: /edit budgets/i }));
    fireEvent.click(screen.getByRole("dialog", { name: /edit budgets/i }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /edit budgets/i })).toBeNull());
  });

  it("uses the real budget id when a new budget is edited before reload finishes", async () => {
    const db = installMatrixDb([], []);
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      const id = table === "budgets" ? "budget-real" : `${table}-real`;
      (table === "budgets" ? db.budgets : db.expenses).push({
        id,
        created_at: new Date().toISOString(),
        ...data,
      });
      return { id };
    });

    render(<App />);
    await screen.findByTestId("empty-state");
    db.find.mockImplementation(async () => new Promise<DbRow[]>(() => undefined));

    fireEvent.click(screen.getByRole("button", { name: /edit budgets/i }));
    fireEvent.change(screen.getByLabelText("Groceries monthly budget"), { target: { value: "100" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole("button", { name: /edit budgets/i }));
    fireEvent.change(screen.getByLabelText("Groceries monthly budget"), { target: { value: "125" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.update).toHaveBeenCalledWith("budgets", "budget-real", { monthly_limit: 125 });
    expect(db.update).not.toHaveBeenCalledWith("budgets", "local-Groceries", expect.anything());
  });

  it("does not reinsert a budget after a mixed save partially commits", async () => {
    const db = installMatrixDb(
      [expense(2, 30, "Groceries"), expense(3, 45, "Rent")],
      [
        { id: "b1", category: "Groceries", monthly_limit: 100 },
        { id: "b2", category: "Groceries", monthly_limit: 125 },
      ],
    );
    db.insert.mockImplementation(async (table: string, data: DbRow) => {
      const id = table === "budgets" ? `budget-${String(data.category).toLowerCase()}` : `${table}-real`;
      (table === "budgets" ? db.budgets : db.expenses).push({
        id,
        created_at: new Date().toISOString(),
        ...data,
      });
      return { id };
    });
    let deleteAttempts = 0;
    db.delete.mockImplementation(async (table: string, id: string) => {
      if (table === "budgets" && id === "b2" && deleteAttempts === 0) {
        deleteAttempts += 1;
        throw new Error("delete failed");
      }
      const rows = table === "budgets" ? db.budgets : db.expenses;
      const idx = rows.findIndex((item) => item.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      return { ok: true };
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /edit budgets/i }));
    fireEvent.change(screen.getByLabelText("Rent monthly budget"), { target: { value: "200" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Could not save your budgets.")).toBeTruthy();
    expect(db.insert.mock.calls.filter((call) => call[0] === "budgets")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.insert.mock.calls.filter((call) => call[0] === "budgets")).toHaveLength(1);
    expect(db.update).toHaveBeenCalledWith("budgets", "budget-rent", { monthly_limit: 200 });
  });

  it("does not restore successfully deleted budgets after a mixed save failure", async () => {
    const db = installMatrixDb(
      [expense(2, 30, "Groceries"), expense(3, 45, "Rent")],
      [
        { id: "b1", category: "Groceries", monthly_limit: 100 },
        { id: "b2", category: "Rent", monthly_limit: 200 },
      ],
    );
    let rentUpdateAttempts = 0;
    db.update.mockImplementation(async (table: string, id: string, data: DbRow) => {
      if (table === "budgets" && id === "b2" && rentUpdateAttempts === 0) {
        rentUpdateAttempts += 1;
        throw new Error("update failed");
      }
      const rows = table === "budgets" ? db.budgets : db.expenses;
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, data);
      return { ok: true };
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /edit budgets/i }));
    fireEvent.change(screen.getByLabelText("Groceries monthly budget"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Rent monthly budget"), { target: { value: "250" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByText("Could not save your budgets.")).toBeTruthy();
    expect(db.delete.mock.calls.filter((call) => call[0] === "budgets" && call[1] === "b1")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save budgets/i }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(db.delete.mock.calls.filter((call) => call[0] === "budgets" && call[1] === "b1")).toHaveLength(1);
    expect(db.update).toHaveBeenCalledWith("budgets", "b2", { monthly_limit: 250 });
  });

  it("renders an empty state with onboarding when there are no transactions", async () => {
    installMatrixDb([], []);

    render(<App />);

    expect(await screen.findByTestId("empty-state")).toBeTruthy();
  });
});
