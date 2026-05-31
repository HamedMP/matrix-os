// Pure, UI-free spend-management logic for the Expense Tracker.
// Everything here is deterministic and unit-tested.

export interface ExpenseRow {
  id: string;
  amount: number;
  category: string;
  note: string;
  spent_at: string; // ISO timestamp
  recurring: boolean;
  created_at?: string;
}

export interface BudgetRow {
  id: string;
  category: string;
  monthly_limit: number;
}

export interface CategoryTotal {
  category: string;
  total: number;
  pct: number; // share of the month's total spend, 0..100
  count: number;
}

export interface BudgetStatus {
  category: string;
  limit: number;
  spent: number;
  remaining: number; // limit - spent (can be negative)
  pct: number; // spent/limit clamped to 0..100 (for bar fill)
  over: boolean;
  hasBudget: boolean;
}

export interface MonthSummary {
  monthKey: string;
  totalSpent: number;
  totalBudget: number;
  remaining: number; // totalBudget - totalSpent
  biggestCategory: CategoryTotal | null;
  breakdown: CategoryTotal[];
  overBudget: BudgetStatus[];
  budgetStatuses: BudgetStatus[];
  transactionCount: number;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Returns "YYYY-MM" for an ISO string or Date. */
export function monthKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    const now = new Date();
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Shifts a "YYYY-MM" key by a number of months (can be negative). */
export function shiftMonth(key: string, delta: number): string {
  const [yearStr, monthStr] = key.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return key;
  // month is 1-based; convert to a 0-based absolute index
  const absolute = year * 12 + (month - 1) + delta;
  const newYear = Math.floor(absolute / 12);
  const newMonth = (absolute % 12 + 12) % 12; // always 0..11
  return `${newYear}-${String(newMonth + 1).padStart(2, "0")}`;
}

/** Human-readable label such as "May 2026". */
export function monthLabel(key: string): string {
  const [yearStr, monthStr] = key.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return key;
  const date = new Date(Date.UTC(year, month - 1, 1));
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

export function isInMonth(expense: ExpenseRow, key: string): boolean {
  return monthKey(expense.spent_at) === key;
}

export function coerceExpense(row: unknown): ExpenseRow | null {
  if (!row || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  const amount = toFiniteNumber(data.amount);
  if (amount === null) return null;
  const spentAt =
    typeof data.spent_at === "string" && data.spent_at.trim() !== ""
      ? data.spent_at
      : typeof data.created_at === "string"
        ? data.created_at
        : new Date().toISOString();
  return {
    id: typeof data.id === "string" ? data.id : crypto.randomUUID(),
    amount: round2(amount),
    category: typeof data.category === "string" && data.category.trim() !== "" ? data.category : "Uncategorized",
    note: typeof data.note === "string" ? data.note : "",
    spent_at: spentAt,
    recurring: data.recurring === true,
    created_at: typeof data.created_at === "string" ? data.created_at : undefined,
  };
}

export function coerceBudget(row: unknown): BudgetRow | null {
  if (!row || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  const limit = toFiniteNumber(data.monthly_limit);
  if (limit === null || limit <= 0) return null;
  if (typeof data.category !== "string" || data.category.trim() === "") return null;
  return {
    id: typeof data.id === "string" ? data.id : crypto.randomUUID(),
    category: data.category,
    monthly_limit: round2(limit),
  };
}

export function monthlyTotal(expenses: ExpenseRow[]): number {
  return round2(expenses.reduce((sum, e) => sum + e.amount, 0));
}

export function categoryBreakdown(expenses: ExpenseRow[]): CategoryTotal[] {
  if (expenses.length === 0) return [];
  const totals = new Map<string, { total: number; count: number }>();
  for (const e of expenses) {
    const entry = totals.get(e.category) ?? { total: 0, count: 0 };
    entry.total += e.amount;
    entry.count += 1;
    totals.set(e.category, entry);
  }
  const grand = monthlyTotal(expenses);
  return Array.from(totals.entries())
    .map(([category, { total, count }]) => ({
      category,
      total: round2(total),
      count,
      pct: grand > 0 ? (total / grand) * 100 : 0,
    }))
    .sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
}

export function budgetStatus(category: string, spent: number, budgets: BudgetRow[]): BudgetStatus {
  const budget = budgets.find((b) => b.category === category);
  const limit = budget ? budget.monthly_limit : 0;
  const hasBudget = Boolean(budget);
  const remaining = round2(limit - spent);
  const over = hasBudget && spent > limit;
  const pct = limit > 0 ? Math.min(100, Math.max(0, (spent / limit) * 100)) : 0;
  return {
    category,
    limit,
    spent: round2(spent),
    remaining,
    pct,
    over,
    hasBudget,
  };
}

export function summarizeMonth(allExpenses: ExpenseRow[], budgets: BudgetRow[], key: string): MonthSummary {
  const monthExpenses = allExpenses.filter((e) => isInMonth(e, key));
  const breakdown = categoryBreakdown(monthExpenses);
  const totalSpent = monthlyTotal(monthExpenses);
  const totalBudget = round2(budgets.reduce((sum, b) => sum + b.monthly_limit, 0));

  // Union of categories that have either spend or a budget this month.
  const spendByCategory = new Map<string, number>();
  for (const item of breakdown) spendByCategory.set(item.category, item.total);
  const categories = new Set<string>([...spendByCategory.keys(), ...budgets.map((b) => b.category)]);
  const budgetStatuses = Array.from(categories)
    .map((category) => budgetStatus(category, spendByCategory.get(category) ?? 0, budgets))
    .sort((a, b) => b.spent - a.spent || a.category.localeCompare(b.category));

  return {
    monthKey: key,
    totalSpent,
    totalBudget,
    remaining: round2(totalBudget - totalSpent),
    biggestCategory: breakdown[0] ?? null,
    breakdown,
    overBudget: budgetStatuses.filter((s) => s.over),
    budgetStatuses,
    transactionCount: monthExpenses.length,
  };
}

const MONEY_FORMAT = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatMoney(value: number): string {
  return MONEY_FORMAT.format(Number.isFinite(value) ? value : 0);
}
