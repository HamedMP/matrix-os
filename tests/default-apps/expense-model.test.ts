import { describe, expect, it } from "vitest";
import {
  budgetStatus,
  categoryBreakdown,
  coerceBudget,
  coerceExpense,
  currencyForLocale,
  dedupeBudgets,
  formatMoney,
  isInMonth,
  monthKey,
  monthLabel,
  monthlyTotal,
  shiftMonth,
  summarizeMonth,
  type BudgetRow,
  type ExpenseRow,
} from "../../home/apps/expense-tracker/src/expense-model";

const may = (day: number, amount: number, category = "Groceries", extra: Partial<ExpenseRow> = {}): ExpenseRow => ({
  id: `e-${day}-${amount}`,
  amount,
  category,
  note: "",
  spent_at: `2026-05-${String(day).padStart(2, "0")}T12:00:00.000Z`,
  recurring: false,
  ...extra,
});

describe("expense-model", () => {
  describe("monthKey / shiftMonth / monthLabel", () => {
    it("derives a YYYY-MM key from an ISO timestamp", () => {
      expect(monthKey("2026-05-14T08:30:00.000Z")).toBe("2026-05");
      expect(monthKey(new Date("2026-12-01T00:00:00.000Z"))).toBe("2026-12");
    });

    it("shifts months across year boundaries", () => {
      expect(shiftMonth("2026-01", -1)).toBe("2025-12");
      expect(shiftMonth("2026-12", 1)).toBe("2027-01");
      expect(shiftMonth("2026-05", 0)).toBe("2026-05");
    });

    it("formats a human month label", () => {
      expect(monthLabel("2026-05")).toMatch(/May 2026/);
    });
  });

  describe("isInMonth", () => {
    it("matches expenses inside the month and rejects others", () => {
      expect(isInMonth(may(3, 10), "2026-05")).toBe(true);
      expect(isInMonth(may(3, 10, "Groceries", { spent_at: "2026-04-30T23:00:00.000Z" }), "2026-05")).toBe(false);
    });
  });

  describe("coerceExpense", () => {
    it("normalizes string amounts and bad rows", () => {
      const row = coerceExpense({ id: "x", amount: "12.5", category: "Food", spent_at: "2026-05-02T00:00:00Z", recurring: true });
      expect(row).not.toBeNull();
      expect(row?.amount).toBe(12.5);
      expect(row?.recurring).toBe(true);
      expect(coerceExpense({ amount: "not-a-number" })).toBeNull();
      expect(coerceExpense(null)).toBeNull();
    });

    it("defaults missing category and spent_at", () => {
      const row = coerceExpense({ amount: 5 });
      expect(row?.category).toBe("Uncategorized");
      expect(typeof row?.spent_at).toBe("string");
    });

    it("hydrates legacy description and date fields", () => {
      const row = coerceExpense({
        id: "legacy",
        amount: "17.45",
        category: "Dining",
        description: "Lunch",
        date: "2026-05-04T00:00:00.000Z",
      });

      expect(row).toMatchObject({
        id: "legacy",
        amount: 17.45,
        category: "Dining",
        note: "Lunch",
        spent_at: "2026-05-04T00:00:00.000Z",
      });
    });
  });

  describe("coerceBudget", () => {
    it("normalizes budget rows and drops invalid limits", () => {
      expect(coerceBudget({ category: "Food", monthly_limit: "200" })?.monthly_limit).toBe(200);
      expect(coerceBudget({ category: "Food", monthly_limit: -3 })).toBeNull();
      expect(coerceBudget({ monthly_limit: 10 })).toBeNull();
    });

    it("deduplicates budgets by category before summarizing", () => {
      expect(dedupeBudgets([
        { id: "b1", category: "Food", monthly_limit: 100 },
        { id: "b2", category: "Food", monthly_limit: 200 },
        { id: "b3", category: "Rent", monthly_limit: 900 },
      ])).toEqual([
        { id: "b1", category: "Food", monthly_limit: 100 },
        { id: "b3", category: "Rent", monthly_limit: 900 },
      ]);
    });
  });

  describe("monthlyTotal", () => {
    it("sums amounts", () => {
      expect(monthlyTotal([may(1, 10), may(2, 5.5), may(3, 4.5)])).toBe(20);
      expect(monthlyTotal([])).toBe(0);
    });
  });

  describe("categoryBreakdown", () => {
    it("aggregates by category sorted by spend desc with percentages", () => {
      const expenses = [
        may(1, 30, "Groceries"),
        may(2, 10, "Groceries"),
        may(3, 60, "Rent"),
      ];
      const rows = categoryBreakdown(expenses);
      expect(rows[0].category).toBe("Rent");
      expect(rows[0].total).toBe(60);
      expect(rows[1].category).toBe("Groceries");
      expect(rows[1].total).toBe(40);
      // 60 of 100 total
      expect(Math.round(rows[0].pct)).toBe(60);
    });

    it("returns empty array for no expenses", () => {
      expect(categoryBreakdown([])).toEqual([]);
    });
  });

  describe("budgetStatus", () => {
    const budgets: BudgetRow[] = [{ id: "b1", category: "Groceries", monthly_limit: 100 }];

    it("reports under-budget status", () => {
      const status = budgetStatus("Groceries", 40, budgets);
      expect(status.limit).toBe(100);
      expect(status.spent).toBe(40);
      expect(status.remaining).toBe(60);
      expect(status.over).toBe(false);
      expect(Math.round(status.pct)).toBe(40);
    });

    it("flags over-budget categories", () => {
      const status = budgetStatus("Groceries", 130, budgets);
      expect(status.over).toBe(true);
      expect(status.remaining).toBe(-30);
      expect(status.pct).toBe(100); // clamped for the bar
    });

    it("handles categories with no budget", () => {
      const status = budgetStatus("Rent", 50, budgets);
      expect(status.limit).toBe(0);
      expect(status.over).toBe(false);
      expect(status.hasBudget).toBe(false);
    });
  });

  describe("summarizeMonth", () => {
    it("produces KPIs for the selected month", () => {
      const expenses = [
        may(1, 100, "Rent"),
        may(2, 30, "Groceries"),
        may(3, 20, "Groceries"),
        may(4, 999, "Rent", { spent_at: "2026-04-15T00:00:00.000Z" }), // out of month
      ];
      const budgets: BudgetRow[] = [
        { id: "b1", category: "Rent", monthly_limit: 120 },
        { id: "b2", category: "Groceries", monthly_limit: 200 },
      ];
      const summary = summarizeMonth(expenses, budgets, "2026-05");
      expect(summary.totalSpent).toBe(150);
      expect(summary.totalBudget).toBe(320);
      expect(summary.remaining).toBe(170);
      expect(summary.biggestCategory?.category).toBe("Rent");
      expect(summary.overBudget).toEqual([]); // Rent 100 < 120, Groceries 50 < 200
    });

    it("identifies over-budget categories", () => {
      const expenses = [may(1, 300, "Rent")];
      const budgets: BudgetRow[] = [{ id: "b1", category: "Rent", monthly_limit: 120 }];
      const summary = summarizeMonth(expenses, budgets, "2026-05");
      expect(summary.overBudget.map((b) => b.category)).toContain("Rent");
    });
  });

  describe("formatMoney", () => {
    it("formats currency", () => {
      expect(formatMoney(1234.5)).toMatch(/1,234\.50/);
      expect(formatMoney(0)).toMatch(/0\.00/);
    });

    it("chooses a locale default currency without hardcoding every display to USD", () => {
      expect(currencyForLocale("sv-SE")).toBe("SEK");
      expect(currencyForLocale("en-GB")).toBe("GBP");
      expect(currencyForLocale("fr-FR")).toBe("EUR");
    });
  });
});
