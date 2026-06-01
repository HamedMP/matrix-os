import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowDownUp,
  ChevronLeft,
  ChevronRight,
  Pencil,
  PiggyBank,
  Plus,
  Repeat,
  Trash2,
  TrendingDown,
  Wallet,
  X,
} from "lucide-react";
import {
  budgetStatus,
  coerceBudget,
  coerceExpense,
  currencyForLocale,
  dedupeBudgets,
  formatMoney,
  monthKey,
  monthLabel,
  shiftMonth,
  summarizeMonth,
  type BudgetRow,
  type ExpenseRow,
} from "./expense-model";
import "./styles.css";

const EXPENSES_TABLE = "expenses";
const BUDGETS_TABLE = "budgets";
const READ_PAGE_SIZE = 500;

const DEFAULT_CATEGORIES = [
  "Groceries",
  "Rent",
  "Dining",
  "Transport",
  "Utilities",
  "Shopping",
  "Health",
  "Entertainment",
  "Subscriptions",
  "Other",
] as const;

// Stable, accessible palette for category accents.
const CATEGORY_PALETTE = [
  "#D06F25", // clay
  "#3A7D44", // moss
  "#3E6DAF", // slate blue
  "#B0573E", // terracotta
  "#7A5BB0", // plum
  "#C99A2E", // amber
  "#2F8A8A", // teal
  "#B23A6E", // berry
  "#5E7A2F", // olive
  "#7A7768", // stone
];

function colorForCategory(category: string): string {
  let hash = 0;
  for (let i = 0; i < category.length; i += 1) {
    hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  }
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length];
}

type LoadState = "loading" | "ready" | "error";

function todayInputValue(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function findAllRows(
  db: NonNullable<NonNullable<Window["MatrixOS"]>["db"]>,
  table: string,
  opts: { orderBy?: Record<string, "asc" | "desc">; limit?: number } = {},
): Promise<Record<string, unknown>[]> {
  const pageSize = opts.limit ?? READ_PAGE_SIZE;
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await db.find(table, { orderBy: opts.orderBy, limit: pageSize, offset });
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

function dateInputToIso(value: string): string {
  if (!value) return new Date().toISOString();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function isoToDateInput(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? todayInputValue() : date.toISOString().slice(0, 10);
}

interface DraftExpense {
  amount: string;
  category: string;
  note: string;
  date: string;
  recurring: boolean;
}

type BudgetOperationResult =
  | { type: "insert"; budget: BudgetRow }
  | { type: "delete"; id: string }
  | { type: "update" };

function emptyDraft(): DraftExpense {
  return {
    amount: "",
    category: DEFAULT_CATEGORIES[0],
    note: "",
    date: todayInputValue(),
    recurring: false,
  };
}

export default function App() {
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [budgets, setBudgets] = useState<BudgetRow[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>(() => monthKey(new Date()));
  const [draft, setDraft] = useState<DraftExpense>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [budgetEditor, setBudgetEditor] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState<Record<string, string>>({});
  const submittingRef = useRef(false);
  const budgetDuplicatesRef = useRef<Map<string, BudgetRow[]>>(new Map());
  const currency = useMemo(() => currencyForLocale(navigator.language), []);

  const reload = useCallback(async () => {
    const db = window.MatrixOS?.db;
    if (!db) {
      setLoadState("ready");
      return;
    }
    try {
      const [rawExpenses, rawBudgets] = await Promise.all([
        findAllRows(db, EXPENSES_TABLE, { orderBy: { spent_at: "desc" } }),
        findAllRows(db, BUDGETS_TABLE),
      ]);
      setExpenses(
        rawExpenses
          .map(coerceExpense)
          .filter((row): row is ExpenseRow => row !== null),
      );
      const coercedBudgets = rawBudgets
        .map(coerceBudget)
        .filter((row): row is BudgetRow => row !== null);
      const duplicates = new Map<string, BudgetRow[]>();
      const seen = new Set<string>();
      for (const budget of coercedBudgets) {
        if (!seen.has(budget.category)) {
          seen.add(budget.category);
          continue;
        }
        const rows = duplicates.get(budget.category) ?? [];
        rows.push(budget);
        duplicates.set(budget.category, rows);
      }
      budgetDuplicatesRef.current = duplicates;
      setBudgets(dedupeBudgets(coercedBudgets));
      setError(null);
      setLoadState("ready");
    } catch (err: unknown) {
      console.warn(
        "[expense-tracker] load failed:",
        err instanceof Error ? err.message : String(err),
      );
      setError("Could not load your spending data. Showing what's available locally.");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    void reload();
    const db = window.MatrixOS?.db;
    if (!db?.onChange) return undefined;
    const unsubExpenses = db.onChange(EXPENSES_TABLE, () => void reload());
    const unsubBudgets = db.onChange(BUDGETS_TABLE, () => void reload());
    return () => {
      unsubExpenses?.();
      unsubBudgets?.();
    };
  }, [reload]);

  useEffect(() => {
    if (!budgetEditor) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBudgetEditor(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [budgetEditor]);

  const summary = useMemo(
    () => summarizeMonth(expenses, budgets, selectedMonth),
    [expenses, budgets, selectedMonth],
  );
  const hasBudget = summary.totalBudget > 0;
  const isOverBudget = hasBudget && summary.remaining < 0;

  const monthExpenses = useMemo(
    () =>
      expenses
        .filter((e) => monthKey(e.spent_at) === selectedMonth)
        .sort((a, b) => b.spent_at.localeCompare(a.spent_at)),
    [expenses, selectedMonth],
  );

  const knownCategories = useMemo(() => {
    const set = new Set<string>(DEFAULT_CATEGORIES);
    for (const e of expenses) set.add(e.category);
    for (const b of budgets) set.add(b.category);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [expenses, budgets]);

  const resetDraft = useCallback(() => {
    setDraft(emptyDraft());
    setEditingId(null);
  }, []);

  const submitExpense = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (submittingRef.current) return;
      const amount = Number(draft.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        setError("Enter an amount greater than zero.");
        return;
      }
      submittingRef.current = true;
      setError(null);

      const payload = {
        amount,
        category: draft.category.trim() || "Other",
        note: draft.note.trim(),
        spent_at: dateInputToIso(draft.date),
        recurring: draft.recurring,
      };
      const db = window.MatrixOS?.db;

      if (editingId) {
        const previous = expenses;
        const previousMonth = selectedMonth;
        setExpenses((current) =>
          current.map((e) => (e.id === editingId ? { ...e, ...payload } : e)),
        );
        setSelectedMonth(monthKey(payload.spent_at));
        resetDraft();
        try {
          if (db) await db.update(EXPENSES_TABLE, editingId, payload);
        } catch (err: unknown) {
          console.warn(
            "[expense-tracker] update failed:",
            err instanceof Error ? err.message : String(err),
          );
          setExpenses(previous);
          setSelectedMonth(previousMonth);
          setError("Could not save that change.");
          return;
        } finally {
          submittingRef.current = false;
        }
        void reload();
        return;
      }

      const optimistic: ExpenseRow = {
        id: `local-${Date.now()}`,
        ...payload,
        created_at: new Date().toISOString(),
      };
      setExpenses((current) => [optimistic, ...current]);
      // Keep the month in view so the new row is visible.
      const previousMonth = selectedMonth;
      setSelectedMonth(monthKey(payload.spent_at));
      resetDraft();
      try {
        if (db) await db.insert(EXPENSES_TABLE, payload);
      } catch (err: unknown) {
        console.warn(
          "[expense-tracker] insert failed:",
          err instanceof Error ? err.message : String(err),
        );
        setExpenses((current) => current.filter((e) => e.id !== optimistic.id));
        setSelectedMonth(previousMonth);
        setError("Could not save that transaction.");
        return;
      } finally {
        submittingRef.current = false;
      }
      void reload();
    },
    [draft, editingId, expenses, reload, resetDraft, selectedMonth],
  );

  const startEdit = useCallback((expense: ExpenseRow) => {
    setEditingId(expense.id);
    setDraft({
      amount: String(expense.amount),
      category: expense.category,
      note: expense.note,
      date: isoToDateInput(expense.spent_at),
      recurring: expense.recurring,
    });
  }, []);

  const deleteExpense = useCallback(
    async (id: string) => {
      const previous = expenses;
      setExpenses((current) => current.filter((e) => e.id !== id));
      if (editingId === id) resetDraft();
      const db = window.MatrixOS?.db;
      try {
        if (db) await db.delete(EXPENSES_TABLE, id);
      } catch (err: unknown) {
        console.warn(
          "[expense-tracker] delete failed:",
          err instanceof Error ? err.message : String(err),
        );
        setExpenses(previous);
        setError("Could not delete that transaction.");
        return;
      }
      void reload();
    },
    [editingId, expenses, reload, resetDraft],
  );

  const openBudgetEditor = useCallback(() => {
    const next: Record<string, string> = {};
    for (const category of knownCategories) {
      const existing = budgets.find((b) => b.category === category);
      next[category] = existing ? String(existing.monthly_limit) : "";
    }
    setBudgetDraft(next);
    setBudgetEditor(true);
  }, [budgets, knownCategories]);

  const saveBudgets = useCallback(async () => {
    const db = window.MatrixOS?.db;
    const previous = budgets;
    const existingByCategory = new Map<string, BudgetRow[]>();
    for (const budget of budgets) {
      const rows = existingByCategory.get(budget.category) ?? [];
      rows.push(budget);
      rows.push(...(budgetDuplicatesRef.current.get(budget.category) ?? []));
      existingByCategory.set(budget.category, rows);
    }
    const next: BudgetRow[] = [];
    const operations: Array<Promise<BudgetOperationResult>> = [];
    for (const [category, value] of Object.entries(budgetDraft)) {
      const limit = Number(value);
      const existingRows = existingByCategory.get(category) ?? [];
      const existing = existingRows[0];
      for (const duplicate of existingRows.slice(1)) {
        if (db) operations.push(db.delete(BUDGETS_TABLE, duplicate.id).then(() => ({ type: "delete", id: duplicate.id })));
      }
      if (!value || !Number.isFinite(limit) || limit <= 0) {
        if (existing && db) operations.push(db.delete(BUDGETS_TABLE, existing.id).then(() => ({ type: "delete", id: existing.id })));
        continue;
      }
      const localId = existing?.id ?? `local-${category}`;
      next.push({ id: localId, category, monthly_limit: limit });
      if (db) {
        operations.push(
          existing
            ? db.update(BUDGETS_TABLE, existing.id, { monthly_limit: limit }).then(() => ({ type: "update" }))
            : db
                .insert(BUDGETS_TABLE, { category, monthly_limit: limit })
                .then(({ id }) => ({ type: "insert", budget: { id, category, monthly_limit: limit } })),
        );
      }
    }
    setBudgets(next);
    setBudgetEditor(false);
    const results = await Promise.allSettled(operations);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    const insertedBudgets = results
      .filter(
        (result): result is PromiseFulfilledResult<BudgetOperationResult> =>
          result.status === "fulfilled" && result.value.type === "insert",
      )
      .map((result) => (result.value as { type: "insert"; budget: BudgetRow }).budget);
    const deletedBudgetIds = new Set(
      results
        .filter(
          (result): result is PromiseFulfilledResult<BudgetOperationResult> =>
            result.status === "fulfilled" && result.value.type === "delete",
        )
        .map((result) => (result.value as { type: "delete"; id: string }).id),
    );
    if (failed) {
      console.warn(
        "[expense-tracker] budget save failed:",
        failed.reason instanceof Error ? failed.reason.message : String(failed.reason),
      );
      const rollbackBase = previous.filter((budget) => !deletedBudgetIds.has(budget.id));
      setBudgets(
        insertedBudgets.length > 0
          ? dedupeBudgets([...rollbackBase, ...insertedBudgets])
          : rollbackBase,
      );
      setBudgetEditor(true);
      setError("Could not save your budgets.");
      return;
    }
    if (insertedBudgets.length > 0) {
      setBudgets((current) =>
        current.map((budget) => insertedBudgets.find((inserted) => inserted.category === budget.category) ?? budget),
      );
    }
    void reload();
  }, [budgetDraft, budgets, reload]);

  const isEmpty = loadState === "ready" && expenses.length === 0 && budgets.length === 0;
  const maxCategoryTotal = summary.breakdown[0]?.total ?? 0;

  return (
    <main className="exp-app">
      <header className="exp-header">
        <div className="exp-brand">
          <span className="exp-brand__mark" aria-hidden="true">
            <Wallet size={18} />
          </span>
          <div>
            <p className="exp-eyebrow">Spending</p>
            <h1>Money</h1>
          </div>
        </div>
        <div className="exp-month-switch" role="group" aria-label="Selected month">
          <button
            type="button"
            className="exp-icon-btn"
            aria-label="Previous month"
            onClick={() => setSelectedMonth((m) => shiftMonth(m, -1))}
          >
            <ChevronLeft size={18} />
          </button>
          <span className="exp-month-label" data-testid="selected-month">
            {monthLabel(selectedMonth)}
          </span>
          <button
            type="button"
            className="exp-icon-btn"
            aria-label="Next month"
            onClick={() => setSelectedMonth((m) => shiftMonth(m, 1))}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </header>

      {error ? (
        <div className="exp-banner" role="status">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      ) : null}

      <section className="exp-kpis" aria-label="Monthly key figures">
        <article className="exp-kpi exp-kpi--spent">
          <span className="exp-kpi__label">
            <TrendingDown size={15} /> Spent this month
          </span>
          <strong data-testid="kpi-total">{formatMoney(summary.totalSpent, currency)}</strong>
          <em>{summary.transactionCount} transactions</em>
        </article>
        <article
          className={
            isOverBudget ? "exp-kpi exp-kpi--over" : "exp-kpi exp-kpi--remaining"
          }
        >
          <span className="exp-kpi__label">
            <PiggyBank size={15} /> {isOverBudget ? "Over budget" : hasBudget ? "Remaining budget" : "Budget not set"}
          </span>
          <strong data-testid="kpi-remaining">
            {formatMoney(hasBudget ? Math.abs(summary.remaining) : 0, currency)}
          </strong>
          <em>{summary.totalBudget > 0 ? `of ${formatMoney(summary.totalBudget, currency)}` : "No budgets set"}</em>
        </article>
        <article className="exp-kpi exp-kpi--top">
          <span className="exp-kpi__label">
            <ArrowDownUp size={15} /> Biggest category
          </span>
          <strong data-testid="kpi-biggest">{summary.biggestCategory?.category ?? "—"}</strong>
          <em>{summary.biggestCategory ? formatMoney(summary.biggestCategory.total, currency) : "Nothing yet"}</em>
        </article>
      </section>

      {summary.overBudget.length > 0 ? (
        <div className="exp-warning" data-testid="over-budget-warning" role="alert">
          <AlertTriangle size={16} />
          <span>
            Over budget in{" "}
            {summary.overBudget.map((b) => b.category).join(", ")} — review your spending.
          </span>
        </div>
      ) : null}

      <div className="exp-grid">
        <section className="exp-card exp-breakdown" aria-label="Spending by category">
          <div className="exp-card__head">
            <h2>By category</h2>
            <button type="button" className="exp-text-btn" onClick={openBudgetEditor}>
              Edit budgets
            </button>
          </div>

          {summary.breakdown.length === 0 ? (
            <p className="exp-card__hint">No spending recorded for {monthLabel(selectedMonth)}.</p>
          ) : (
            <div className="exp-bars" data-testid="category-breakdown">
              {summary.breakdown.map((row) => {
                const status = budgetStatus(row.category, row.total, budgets);
                const fill = maxCategoryTotal > 0 ? (row.total / maxCategoryTotal) * 100 : 0;
                const color = colorForCategory(row.category);
                return (
                  <div className="exp-bar" key={row.category}>
                    <div className="exp-bar__top">
                      <span className="exp-bar__name">
                        <span className="exp-dot" style={{ background: color }} aria-hidden="true" />
                        {row.category}
                        {status.over ? <span className="exp-tag exp-tag--over">over</span> : null}
                      </span>
                      <span className="exp-bar__amt">{formatMoney(row.total, currency)}</span>
                    </div>
                    <div className="exp-bar__track">
                      <div
                        className="exp-bar__fill"
                        style={{ width: `${Math.max(4, fill)}%`, background: color }}
                      />
                    </div>
                    <div className="exp-bar__meta">
                      {status.hasBudget ? (
                        <span className={status.over ? "exp-over" : ""}>
                          {formatMoney(row.total, currency)} of {formatMoney(status.limit, currency)} budget
                          {status.over
                            ? ` · ${formatMoney(Math.abs(status.remaining), currency)} over`
                            : ` · ${formatMoney(status.remaining, currency)} left`}
                        </span>
                      ) : (
                        <span>{Math.round(row.pct)}% of spend · no budget</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="exp-card exp-compose" aria-label="Add a transaction">
          <div className="exp-card__head">
            <h2>{editingId ? "Edit transaction" : "Add transaction"}</h2>
            {editingId ? (
              <button type="button" className="exp-text-btn" onClick={resetDraft}>
                Cancel
              </button>
            ) : null}
          </div>
          <form className="exp-form" data-testid="expense-form" onSubmit={submitExpense}>
            <label className="exp-field">
              <span>Amount</span>
              <input
                aria-label="Amount"
                inputMode="decimal"
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={draft.amount}
                onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))}
              />
            </label>
            <label className="exp-field">
              <span>Category</span>
              <input
                aria-label="Category"
                list="exp-categories"
                value={draft.category}
                onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
              />
              <datalist id="exp-categories">
                {knownCategories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label className="exp-field exp-field--wide">
              <span>Note</span>
              <input
                aria-label="Note"
                type="text"
                placeholder="What was it for?"
                value={draft.note}
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              />
            </label>
            <label className="exp-field">
              <span>Date</span>
              <input
                aria-label="Date"
                type="date"
                value={draft.date}
                onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
              />
            </label>
            <label className="exp-check">
              <input
                type="checkbox"
                checked={draft.recurring}
                onChange={(e) => setDraft((d) => ({ ...d, recurring: e.target.checked }))}
              />
              <Repeat size={14} /> Recurring bill
            </label>
            <button type="submit" className="exp-primary">
              <Plus size={16} /> {editingId ? "Save changes" : "Add expense"}
            </button>
          </form>
        </section>
      </div>

      <section className="exp-card exp-transactions" aria-label="Transactions">
        <div className="exp-card__head">
          <h2>Transactions</h2>
          <span className="exp-card__hint">{monthLabel(selectedMonth)}</span>
        </div>

        {isEmpty ? (
          <div className="exp-empty" data-testid="empty-state">
            <span className="exp-empty__mark" aria-hidden="true">
              <Wallet size={28} />
            </span>
            <strong>Track your first expense</strong>
            <span>
              Add what you spent above to see your monthly total, category breakdown, and budget
              progress build up over time.
            </span>
          </div>
        ) : monthExpenses.length === 0 ? (
          <div className="exp-empty" data-testid="empty-state">
            <span className="exp-empty__mark" aria-hidden="true">
              <Wallet size={28} />
            </span>
            <strong>Nothing in {monthLabel(selectedMonth)}</strong>
            <span>Switch months or add a transaction for this period.</span>
          </div>
        ) : (
          <ul className="exp-list">
            {monthExpenses.map((expense) => (
              <li className="exp-row" key={expense.id}>
                <span
                  className="exp-dot exp-dot--lg"
                  style={{ background: colorForCategory(expense.category) }}
                  aria-hidden="true"
                />
                <div className="exp-row__main">
                  <strong>{expense.note || expense.category}</strong>
                  <span className="exp-row__sub">
                    {expense.category}
                    {expense.recurring ? (
                      <span className="exp-tag exp-tag--recur">
                        <Repeat size={11} /> recurring
                      </span>
                    ) : null}
                    {" · "}
                    {new Date(expense.spent_at).toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </span>
                </div>
                <span className="exp-row__amt">{formatMoney(expense.amount, currency)}</span>
                <div className="exp-row__actions">
                  <button
                    type="button"
                    className="exp-icon-btn exp-icon-btn--sm"
                    aria-label={`Edit ${expense.note || expense.category}`}
                    onClick={() => startEdit(expense)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="exp-icon-btn exp-icon-btn--sm exp-icon-btn--danger"
                    aria-label={`Delete ${expense.note || expense.category}`}
                    onClick={() => void deleteExpense(expense.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {budgetEditor ? (
        <div
          className="exp-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Edit budgets"
          onClick={() => setBudgetEditor(false)}
        >
          <div className="exp-overlay__panel" onClick={(event) => event.stopPropagation()}>
            <div className="exp-card__head">
              <h2>Monthly budgets</h2>
              <button
                type="button"
                className="exp-icon-btn exp-icon-btn--sm"
                aria-label="Close budgets"
                onClick={() => setBudgetEditor(false)}
              >
                <X size={16} />
              </button>
            </div>
            <div className="exp-budget-list">
              {knownCategories.map((category) => (
                <label className="exp-budget-row" key={category}>
                  <span className="exp-dot" style={{ background: colorForCategory(category) }} aria-hidden="true" />
                  <span className="exp-budget-name">{category}</span>
                  <input
                    aria-label={`${category} monthly budget`}
                    type="number"
                    min="0"
                    step="1"
                    placeholder="No limit"
                    value={budgetDraft[category] ?? ""}
                    onChange={(e) =>
                      setBudgetDraft((d) => ({ ...d, [category]: e.target.value }))
                    }
                  />
                </label>
              ))}
            </div>
            <button type="button" className="exp-primary exp-primary--block" onClick={() => void saveBudgets()}>
              Save budgets
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
