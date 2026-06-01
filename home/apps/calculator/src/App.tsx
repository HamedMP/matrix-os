import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  Copy,
  Delete,
  Equal,
  FlaskConical,
  History as HistoryIcon,
  Trash2,
} from "lucide-react";
import { evaluate, formatResult } from "./calc-engine";
import "./styles.css";

const HISTORY_TABLE = "history";
const LS_KEY = "matrixos.calculator.history.v1";
const MAX_HISTORY = 100;
const MAX_CLEAR_PAGES = 100;

interface HistoryRow {
  id: string;
  expression: string;
  result: string;
  created_at?: string;
}

type LoadState = "ok" | "error";

function coerceRow(row: unknown): HistoryRow | null {
  if (!row || typeof row !== "object") return null;
  const data = row as Record<string, unknown>;
  const expression = typeof data.expression === "string" ? data.expression : null;
  const result = typeof data.result === "string" ? data.result : null;
  if (expression === null || result === null) return null;
  return {
    id: typeof data.id === "string" ? data.id : crypto.randomUUID(),
    expression,
    result,
    created_at: typeof data.created_at === "string" ? data.created_at : undefined,
  };
}

function readLocal(): HistoryRow[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceRow).filter((r): r is HistoryRow => r !== null);
  } catch (err: unknown) {
    console.warn("[calculator] local history read failed:", err instanceof Error ? err.message : String(err));
    return [];
  }
}

function writeLocal(rows: HistoryRow[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(rows.slice(0, MAX_HISTORY)));
  } catch (err: unknown) {
    console.warn("[calculator] local history write failed:", err instanceof Error ? err.message : String(err));
  }
}

// --- Keypad definitions ----------------------------------------------------

interface KeyDef {
  label: string;
  insert: string;
  kind?: "op" | "fn" | "accent";
  aria?: string;
}

// Ordered for a 4-column grid. C/⌫ on the top row, "=" spans the full width.
type PadAction = "clear" | "backspace" | "equals";
interface PadKey {
  label: string;
  kind: "digit" | "op" | "util" | "equals";
  insert?: string;
  action?: PadAction;
  aria?: string;
}
const KEYPAD: PadKey[] = [
  { label: "C", kind: "util", action: "clear", aria: "clear" },
  { label: "⌫", kind: "util", action: "backspace", aria: "delete" },
  { label: "(", kind: "op", insert: "(" },
  { label: ")", kind: "op", insert: ")" },
  { label: "7", kind: "digit", insert: "7" },
  { label: "8", kind: "digit", insert: "8" },
  { label: "9", kind: "digit", insert: "9" },
  { label: "÷", kind: "op", insert: "/", aria: "divide" },
  { label: "4", kind: "digit", insert: "4" },
  { label: "5", kind: "digit", insert: "5" },
  { label: "6", kind: "digit", insert: "6" },
  { label: "×", kind: "op", insert: "*", aria: "multiply" },
  { label: "1", kind: "digit", insert: "1" },
  { label: "2", kind: "digit", insert: "2" },
  { label: "3", kind: "digit", insert: "3" },
  { label: "−", kind: "op", insert: "-", aria: "subtract" },
  { label: "0", kind: "digit", insert: "0" },
  { label: ".", kind: "digit", insert: "." },
  { label: "%", kind: "op", insert: "%", aria: "percent" },
  { label: "+", kind: "op", insert: "+", aria: "add" },
  { label: "=", kind: "equals", action: "equals", aria: "equals" },
];

const SCIENTIFIC_KEYS: KeyDef[] = [
  { label: "sin", insert: "sin(", kind: "fn" },
  { label: "cos", insert: "cos(", kind: "fn" },
  { label: "tan", insert: "tan(", kind: "fn" },
  { label: "π", insert: "pi", kind: "fn", aria: "pi" },
  { label: "ln", insert: "ln(", kind: "fn" },
  { label: "log", insert: "log(", kind: "fn" },
  { label: "√", insert: "sqrt(", kind: "fn", aria: "square root" },
  { label: "e", insert: "e", kind: "fn" },
  { label: "x²", insert: "^2", kind: "fn", aria: "squared" },
  { label: "xʸ", insert: "^", kind: "fn", aria: "power" },
  { label: "x!", insert: "!", kind: "fn", aria: "factorial" },
  { label: "mod", insert: " mod ", kind: "fn", aria: "modulo" },
];

export default function App() {
  const [expr, setExpr] = useState("");
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [scientific, setScientific] = useState(false);
  const [degrees, setDegrees] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const usingDbRef = useRef(false);
  const committingRef = useRef(false);
  const clearingRef = useRef(false);

  // --- Persistence ---------------------------------------------------------
  const reload = useCallback(async (): Promise<LoadState> => {
    const db = window.MatrixOS?.db;
    if (!db) {
      usingDbRef.current = false;
      setHistory(readLocal());
      return "ok";
    }
    usingDbRef.current = true;
    try {
      const rows = await db.find(HISTORY_TABLE, {
        orderBy: { created_at: "desc" },
        limit: MAX_HISTORY,
      });
      const mapped = rows.map(coerceRow).filter((r): r is HistoryRow => r !== null);
      setHistory(mapped);
      setError(null);
      return "ok";
    } catch (err: unknown) {
      console.warn("[calculator] history load failed:", err instanceof Error ? err.message : String(err));
      setError("History could not be loaded.");
      return "error";
    }
  }, []);

  useEffect(() => {
    void reload();
    const db = window.MatrixOS?.db;
    if (!db) return undefined;
    let unsub: (() => void) | undefined;
    try {
      unsub = db.onChange(HISTORY_TABLE, () => {
        void reload();
      });
    } catch (err: unknown) {
      console.warn("[calculator] onChange subscribe failed:", err instanceof Error ? err.message : String(err));
    }
    return () => {
      try {
        unsub?.();
      } catch (err: unknown) {
        console.warn("[calculator] onChange cleanup failed:", err instanceof Error ? err.message : String(err));
      }
    };
  }, [reload]);

  // --- Live evaluation -----------------------------------------------------
  const live = useMemo(() => evaluate(expr, { degrees }), [expr, degrees]);
  const livePreview = expr.trim() !== "" && live.ok ? formatResult(live.value) : "";

  // --- Commit (=/Enter) ----------------------------------------------------
  const commit = useCallback(async () => {
    if (committingRef.current) return;
    const trimmed = expr.trim();
    if (trimmed === "") return;
    const result = evaluate(trimmed, { degrees });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const formatted = formatResult(result.value);
    committingRef.current = true;
    setError(null);

    const optimistic: HistoryRow = {
      id: `local-${Date.now()}`,
      expression: trimmed,
      result: formatted,
      created_at: new Date().toISOString(),
    };
    setHistory((current) => [optimistic, ...current].slice(0, MAX_HISTORY));
    // Carry the result forward as the new working value, Numi-style.
    setExpr(formatted.replace(/,/g, ""));

    const db = window.MatrixOS?.db;
    if (!db) {
      writeLocal([optimistic, ...readLocal()].slice(0, MAX_HISTORY));
      committingRef.current = false;
      return;
    }
    try {
      await db.insert(HISTORY_TABLE, { expression: trimmed, result: formatted });
      await reload();
    } catch (err: unknown) {
      console.warn("[calculator] history save failed:", err instanceof Error ? err.message : String(err));
      setError("Result could not be saved.");
    } finally {
      committingRef.current = false;
    }
  }, [degrees, expr, reload]);

  // --- Input helpers -------------------------------------------------------
  const insert = useCallback((text: string) => {
    setError(null);
    const el = inputRef.current;
    if (!el) {
      setExpr((cur) => cur + text);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setExpr((cur) => cur.slice(0, start) + text + cur.slice(end));
    // Restore caret after the inserted text on the next frame.
    requestAnimationFrame(() => {
      const pos = start + text.length;
      el.focus();
      try {
        el.setSelectionRange(pos, pos);
      } catch {
        /* setSelectionRange unsupported for this input type — caret stays at end */
      }
    });
  }, []);

  const clearAll = useCallback(() => {
    setExpr("");
    setError(null);
    inputRef.current?.focus();
  }, []);

  const backspace = useCallback(() => {
    setError(null);
    const el = inputRef.current;
    if (!el) {
      setExpr((cur) => cur.slice(0, -1));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    if (start === end && start > 0) {
      setExpr((cur) => cur.slice(0, start - 1) + cur.slice(end));
      requestAnimationFrame(() => {
        el.focus();
        try {
          el.setSelectionRange(start - 1, start - 1);
        } catch {
          /* ignore caret restore on unsupported input */
        }
      });
    } else if (start !== end) {
      setExpr((cur) => cur.slice(0, start) + cur.slice(end));
    }
  }, []);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        clearAll();
      }
    },
    [clearAll, commit],
  );

  const copyResult = useCallback(async (row: HistoryRow) => {
    const text = row.result.replace(/,/g, "");
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(row.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === row.id ? null : cur)), 1200);
    } catch (err: unknown) {
      console.warn("[calculator] copy failed:", err instanceof Error ? err.message : String(err));
    }
  }, []);

  const reuse = useCallback((row: HistoryRow) => {
    setExpr(row.expression);
    setError(null);
    inputRef.current?.focus();
  }, []);

  const clearHistory = useCallback(async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    const rows = history;
    setHistory([]);
    const db = window.MatrixOS?.db;
    if (!db) {
      writeLocal([]);
      clearingRef.current = false;
      return;
    }
    try {
      const seen = new Set<string>();
      for (let page = 0; page < MAX_CLEAR_PAGES; page += 1) {
        const pageRows = await db.find(HISTORY_TABLE, {
          orderBy: { created_at: "desc" },
          limit: MAX_HISTORY,
        });
        const ids = pageRows
          .map(coerceRow)
          .filter((r): r is HistoryRow => r !== null)
          .map((row) => row.id)
          .filter((id) => !id.startsWith("local-") && !seen.has(id));
        if (ids.length === 0) break;
        ids.forEach((id) => seen.add(id));
        const results = await Promise.all(ids.map((id) => db.delete(HISTORY_TABLE, id)));
        const failed = results.filter((result) => result.ok === false);
        if (failed.length > 0) throw new Error(`${failed.length} row(s) could not be deleted`);
      }
      await reload();
      writeLocal([]);
    } catch (err: unknown) {
      console.warn("[calculator] history clear failed:", err instanceof Error ? err.message : String(err));
      writeLocal(rows);
      const status = await reload();
      if (status === "error") setHistory(rows);
      setError("History could not be cleared.");
    } finally {
      clearingRef.current = false;
    }
  }, [history, reload]);

  // Keep keyboard usable from anywhere in the window.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <main className="calc-app">
      <section className="calc-pad" aria-label="Calculator">
        <header className="calc-head">
          <div className="brand">
            <span className="brand-mark" aria-hidden="true">
              <Equal size={16} />
            </span>
            <span>Matrix Calc</span>
          </div>
          <div className="head-toggles">
            <button
              type="button"
              className={degrees ? "toggle toggle--on" : "toggle"}
              onClick={() => setDegrees((v) => !v)}
              title="Toggle angle unit"
              aria-pressed={degrees}
            >
              {degrees ? "DEG" : "RAD"}
            </button>
            <button
              type="button"
              className={scientific ? "toggle toggle--on" : "toggle"}
              onClick={() => setScientific((v) => !v)}
              aria-pressed={scientific}
            >
              <FlaskConical size={14} />
              Scientific
            </button>
          </div>
        </header>

        <div className="display">
          <div className="display-row">
            <input
              ref={inputRef}
              data-testid="calc-input"
              className="expr-input"
              value={expr}
              onChange={(e) => {
                setError(null);
                setExpr(e.target.value);
              }}
              onKeyDown={onKeyDown}
              placeholder="Type a calculation…"
              inputMode="text"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Expression"
            />
          </div>
          <div className={error ? "preview preview--error" : "preview"} aria-live="polite">
            {error ? (
              <span>{error}</span>
            ) : livePreview ? (
              <span className="preview-eq">
                <span aria-hidden="true">= </span>
                <span data-testid="live-result">{livePreview}</span>
              </span>
            ) : (
              <span className="preview-hint">Press Enter to evaluate</span>
            )}
          </div>
        </div>

        {scientific && (
          <div className="keypad keypad--sci" role="group" aria-label="Scientific functions">
            {SCIENTIFIC_KEYS.map((k) => (
              <button
                key={k.label}
                type="button"
                className="key key--fn"
                aria-label={k.aria ?? k.label}
                onClick={() => insert(k.insert)}
              >
                {k.label}
              </button>
            ))}
          </div>
        )}

        <div className="keypad" role="group" aria-label="Keypad">
          {KEYPAD.map((k) => {
            const cls =
              k.kind === "op"
                ? "key key--op"
                : k.kind === "util"
                  ? "key key--util"
                  : k.kind === "equals"
                    ? "key key--equals"
                    : "key";
            const handleClick =
              k.action === "clear"
                ? clearAll
                : k.action === "backspace"
                  ? backspace
                  : k.action === "equals"
                    ? () => void commit()
                    : () => insert(k.insert ?? "");
            return (
              <button
                key={k.label}
                type="button"
                className={cls}
                aria-label={k.aria ?? k.label}
                onClick={handleClick}
              >
                {k.label === "⌫" ? <Delete size={18} /> : k.label === "=" ? <Equal size={20} /> : k.label}
              </button>
            );
          })}
        </div>
      </section>

      <aside className="calc-history" aria-label="Calculation history">
        <div className="history-head">
          <div className="history-title">
            <HistoryIcon size={16} />
            <span>History</span>
          </div>
          {history.length > 0 && (
            <button type="button" className="ghost-btn" onClick={() => void clearHistory()}>
              <Trash2 size={14} />
              Clear
            </button>
          )}
        </div>

        <div className="history-rail" data-testid="history-rail">
          {history.length === 0 ? (
            <div className="empty">
              <div className="empty-mark" aria-hidden="true">
                <HistoryIcon size={22} />
              </div>
              <strong>No calculations yet</strong>
              <span>Start typing an expression — results land here and click to copy.</span>
            </div>
          ) : (
            history.map((row) => (
              <div className="hist-item" key={row.id}>
                <button
                  type="button"
                  className="hist-expr"
                  onClick={() => reuse(row)}
                  title="Reuse this expression"
                >
                  {row.expression}
                </button>
                <button
                  type="button"
                  className="hist-result"
                  onClick={() => void copyResult(row)}
                  title="Copy result"
                  aria-label={`Copy result ${row.result}`}
                >
                  <span>{row.result}</span>
                  {copiedId === row.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            ))
          )}
        </div>
      </aside>
    </main>
  );
}
