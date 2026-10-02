import { useEffect, useRef, useState } from "react";
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
  const scope = useRef<AbortController | null>(null);
  const dialog = useRef<HTMLElement | null>(null);
  useDialogFocus(dialog, true, onClose);
  const request = async (next: string | null, controller: AbortController) => {
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
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    scope.current = controller;
    void request(null, controller);
    return () => {
      controller.abort();
      scope.current = null;
    };
  }, [load]);
  return (
    <div className="matrix-ap-dialog-backdrop">
      <section
        ref={dialog}
        className="matrix-ap-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="matrix-ap-history-title"
        aria-busy={busy}
      >
        <div className="matrix-ap-dialog-head">
          <h3 id="matrix-ap-history-title">Usage history</h3>
          <button
            autoFocus
            type="button"
            className="matrix-ap-button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        <p className="matrix-ap-help">
          Matrix AI credit activity for this computer.
        </p>
        {entries.length ? (
          <table className="matrix-ap-history-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Activity</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, index) => (
                <tr key={`${entry.occurredAt}:${index}`}>
                  <td>
                    <time dateTime={entry.occurredAt}>
                      {new Date(entry.occurredAt).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    {entry.kind === "usage"
                      ? "Usage"
                      : entry.kind === "credit"
                        ? "Credit"
                        : "Adjustment"}
                    {entry.modelId ? <small>{entry.modelId}</small> : null}
                  </td>
                  <td>{historyMoney.format(entry.amountMicrousd / 1_000_000)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : loaded ? (
          <p className="matrix-ap-empty">No credit activity yet.</p>
        ) : null}
        {busy ? (
          <p role="status" className="matrix-ap-help">
            Loading usage history…
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="matrix-ap-notice" data-tone="danger">
            Usage history could not be loaded. Try again.
          </p>
        ) : null}
        {(cursor || error) && !busy && entries.length < 500 ? (
          <button
            type="button"
            className="matrix-ap-button"
            onClick={() => {
              if (scope.current)
                void request(loaded ? cursor : null, scope.current);
            }}
          >
            {error ? "Try again" : "Load more"}
          </button>
        ) : null}
      </section>
    </div>
  );
}
