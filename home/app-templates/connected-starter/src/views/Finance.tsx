import { useState } from "react";
import {
  financeSummary,
  recurringSummary,
  receivablesSummary,
  formatMoney,
  dateText,
} from "../model";
import type { OwnerRecord } from "../types";
import Commitments from "./Commitments";
import SpendingCategories from "./SpendingCategories";
import RevenueTrend from "./RevenueTrend";
import { Badge, Empty, type ViewProps } from "./common";
function Obligations({
  records,
  recurring,
}: {
  records: OwnerRecord[];
  recurring: boolean;
}) {
  const grouped = recurring
    ? recurringSummary(records)
    : receivablesSummary(records);
  return (
    <section className="obligations">
      <div className="section-heading">
        <h3>{recurring ? "Active recurring costs" : "Open receivables"}</h3>
        <span>
          {recurring
            ? "Separate by currency and billing cadence"
            : "Sent and overdue invoices, separate from payments"}
        </span>
      </div>
      {Object.keys(grouped).length ? (
        <div className="obligation-grid">
          {Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([currency, buckets]) => (
              <article key={currency}>
                <span className="eyebrow">{currency}</span>
                {Object.entries(buckets).map(([bucket, value]) => (
                  <div key={bucket}>
                    <span>{bucket}</span>
                    <strong>{formatMoney(value, currency)}</strong>
                  </div>
                ))}
              </article>
            ))}
        </div>
      ) : (
        <p className="muted">
          {recurring
            ? "No active subscriptions with a known cost yet."
            : "No sent or overdue invoices with a known amount yet."}
        </p>
      )}
      <p className="fine-print">
        {recurring
          ? "Recurring costs are commitments, not settled spending. Annual, monthly and unknown cadences are never combined."
          : "Receivables are expected payments. They do not count as settled cash until marked Paid."}
      </p>
    </section>
  );
}
export default function Finance(props: ViewProps) {
  const { records, app } = props,
    summary = financeSummary(records);
  const [currency, setCurrency] = useState(""),
    [period, setPeriod] = useState<"months" | "weeks">("months");
  const chosen = summary.currencies.includes(currency)
    ? currency
    : summary.currencies[0];
  const points = Object.entries(chosen ? (summary[period][chosen] ?? {}) : {})
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12),
    max = Math.max(1, ...points.map(([, v]) => v));
  return (
    <>
      {app.id === "subscriptions" ? (
        <Obligations records={records} recurring />
      ) : (
        <div className={`finance-overview ${app.id === "revenue" ? "revenue-overview" : "spending-desk"}`}>
          <section className="balance">
            <span className="eyebrow">
              Settled {app.id === "revenue" ? "revenue" : "amounts"}
            </span>
            <h2>
              {chosen
                ? formatMoney(summary.totals[chosen], chosen)
                : "No settled amounts"}
            </h2>
            <p>
              Paid and succeeded records only. Refunds, unpaid notices and
              unknown amounts are kept in the ledger.
            </p>
            {summary.currencies.length > 0 && (
              <select
                aria-label="Chart currency"
                value={chosen}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {summary.currencies.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            )}
          </section>
          <section className="chart-card">
            <div className="section-heading">
              <h3>{period === "months" ? "Monthly" : "Weekly"} activity</h3>
              <div className="segmented">
                <button
                  aria-pressed={period === "months"}
                  onClick={() => setPeriod("months")}
                >
                  Monthly
                </button>
                <button
                  aria-pressed={period === "weeks"}
                  onClick={() => setPeriod("weeks")}
                >
                  Weekly
                </button>
              </div>
            </div>
            {points.length ? (
              <div
                className={`bar-chart ${app.id === "revenue" ? "revenue-trend" : ""}`}
                role="img"
                aria-label={`${chosen} settled amounts by ${period}`}
              >
                {app.id === "revenue" && <RevenueTrend points={points} max={max} />}
                {points.map(([label, value]) => (
                  <div className="bar-column" key={label}>
                    <span className="bar-value">
                      {formatMoney(value, chosen)}
                    </span>
                    <div
                      className="bar"
                      style={{ height: Math.max(3, (value / max) * 125) }}
                    />
                    <span>{period === "months" ? label : label.slice(5)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="chart-empty">
                Your dated, settled records will form a chart here.
              </div>
            )}
          </section>
        </div>
      )}
      {app.id === "folio" && <SpendingCategories records={records} currency={chosen} />}
      {app.id === "cashflow" && (
        <Obligations records={records} recurring={false} />
      )}
      {app.id === "subscriptions" ? <Commitments {...props} /> : <Ledger {...props} />}
    </>
  );
}

function Ledger(props: ViewProps) {
  const { records, app } = props;
  return (
    <section className={`ledger ${app.id === "revenue" ? "revenue-ledger" : "receipt-ledger"}`}>
      <div className="section-heading">
        <h3>
          {app.id === "revenue" ? "Payment ledger" : "Receipts & invoices"}
        </h3>
        <span className="muted">Currencies stay separate</span>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Record</th>
              <th>Date</th>
              <th>Status</th>
              <th>Amount</th>
              <th>Evidence</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{String(r.fields.title ?? "Untitled")}</strong>
                  <small>
                    {String(r.fields.provider ?? r.fields.client ?? r.scope)}
                  </small>
                </td>
                <td>{dateText(r.fields.date)}</td>
                <td>
                  <Badge value={r.fields.status} />
                </td>
                <td className="money">
                  {typeof r.fields.amount === "number" &&
                  typeof r.fields.currency === "string"
                    ? formatMoney(r.fields.amount, r.fields.currency)
                    : "To confirm"}
                </td>
                <td>
                  <button onClick={() => props.onEvidence(r)}>
                    {r.sources.length
                      ? `${r.sources.length} sources`
                      : "Manual"}
                  </button>
                </td>
                <td>
                  <button
                    aria-label={`Edit ${r.fields.title}`}
                    onClick={() => props.onEdit(r)}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!records.length && <Empty app={app} onAdd={props.onAdd} />}
    </section>
  );
}
