import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiCreditHistoryEntry,
  AiCreditHistoryResponse,
} from "@matrix-os/contracts";
import { useDialogFocus } from "./use-dialog-focus.js";

// Ledger entries are exact microUSD amounts; cent rounding would make real
// subcent inference charges appear free. Balance cards keep their own format.
const historyMoney = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

const modelNames: Readonly<Record<string, string>> = {
  "anthropic/claude-sonnet-5": "Claude Sonnet 5",
  "@cf/zai-org/glm-5.3-flash": "GLM 5.3 Flash",
};
const historyDate = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const historyTime = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export function UsageHistoryDialog({
  load,
  onClose,
}: {
  load: (
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<AiCreditHistoryResponse>;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<AiCreditHistoryEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [stateLoader, setStateLoader] = useState(() => load);
  if (stateLoader !== load) {
    setStateLoader(() => load); setEntries([]); setCursor(null); setLoaded(false); setError(false);
  }
  const scope = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  const pending = useRef(false);
  useDialogFocus(dialog, true, onClose);
  const request = useCallback(async (next: string | null, controller: AbortController) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    try {
      const result = await load(next, controller.signal);
      if (controller.signal.aborted || scope.current !== controller) return;
      setEntries((previous) =>
        next === null
          ? result.entries
          : [...previous, ...result.entries].slice(0, 500),
      );
      setCursor(result.nextCursor);
      setLoaded(true);
    } catch (caught) {
      if (!controller.signal.aborted) {
        console.warn(
          "[provider-settings] History request failed:",
          caught instanceof Error ? caught.name : typeof caught,
        );
        setError(true);
      }
    } finally {
      if (scope.current === controller) {
        pending.current = false;
        setBusy(false);
      }
    }
  }, [load]);
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    pending.current = false;
    void request(null, controller);
    return () => {
      controller.abort();
      scope.current = null;
    };
  }, [load, request]);
  return (
    <div className="matrix-ap-dialog-backdrop">
      <section
        ref={dialog}
        className="matrix-ap-dialog matrix-ap-history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-ap-history-title"
        aria-busy={busy}
      >
        <header className="matrix-ap-dialog-head matrix-ap-history-head">
          <div>
            <span className="matrix-ap-eyebrow">Matrix AI</span>
            <h3 id="matrix-ap-history-title">Usage history</h3>
            <p className="matrix-ap-help">Credit activity for this computer · USD</p>
          </div>
          <button
            type="button"
            className="matrix-ap-icon-button"
            aria-label="Close"
            onClick={onClose}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div
          className="matrix-ap-history-scroll"
          role="region"
          aria-label="Credit activity"
          tabIndex={0}
        >
          {entries.length ? (
            <table className="matrix-ap-history-table">
              <thead>
                <tr>
                  <th scope="col">Activity</th>
                  <th scope="col">Date</th>
                  <th scope="col">Amount</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => {
                  const date = new Date(entry.occurredAt);
                  const label = entry.kind === "usage"
                    ? "Usage"
                    : entry.kind === "credit" ? "Credit" : "Adjustment";
                  return (
                    <tr key={`${entry.occurredAt}:${index}`}>
                      <td>
                        <span
                          className="matrix-ap-history-model"
                          title={entry.modelId ?? undefined}
                        >
                          {entry.modelId
                            ? modelNames[entry.modelId] ?? entry.modelId
                            : entry.kind === "credit"
                              ? "Credit added"
                              : entry.kind === "usage"
                                ? "Model usage"
                                : "Balance adjustment"}
                        </span>
                        <span className="matrix-ap-history-kind" data-kind={entry.kind}>
                          {label}
                        </span>
                      </td>
                      <td>
                        <time dateTime={entry.occurredAt}>
                          {historyDate.format(date)}
                          <small>{historyTime.format(date)}</small>
                        </time>
                      </td>
                      <td className="matrix-ap-history-amount" data-kind={entry.kind}>
                        {historyMoney.format(entry.amountMicrousd / 1_000_000)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : loaded ? (
            <div className="matrix-ap-history-state">
              <strong>No activity yet</strong>
              <p>Credit purchases and model usage will appear here.</p>
            </div>
          ) : busy ? (
            <div className="matrix-ap-history-state" role="status">
              Loading usage history…
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="matrix-ap-notice" data-tone="danger">
              Usage history could not be loaded. Try again.
            </p>
          ) : null}
        </div>
        <footer className="matrix-ap-history-footer">
          <span className="matrix-ap-help" role="status">
            {loaded
              ? `${entries.length} ${entries.length === 1 ? "activity" : "activities"}${entries.length >= 500 ? " · Showing the latest 500" : ""}`
              : ""}
          </span>
          {(cursor || error) && entries.length < 500 ? (
            <button
              type="button"
              className="matrix-ap-button"
              disabled={busy}
              onClick={() => {
                if (scope.current)
                  void request(loaded ? cursor : null, scope.current);
              }}
            >
              {busy ? "Loading…" : error ? "Try again" : "Load more"}
            </button>
          ) : loaded ? (
            <span className="matrix-ap-help">{cursor ? "Activity limit reached" : "All activity loaded"}</span>
          ) : null}
        </footer>
      </section>
    </div>
  );
}
