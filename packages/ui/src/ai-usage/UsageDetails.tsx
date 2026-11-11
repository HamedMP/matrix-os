import React from "react";
import { UsageSelect } from "./UsageSelect";
import type { UsageHistory, UsageSummary } from "@matrix-os/contracts/ai-usage";
import { number, money, agentName, formatBytes } from "./format";
const coverageDate = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeZone: "UTC",
});
const reportTime = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const date = (value: string) => coverageDate.format(new Date(value));
export function HistoryCoverage({ history }: { history: UsageHistory }) {
  const c = history.coverage,
    backup = c.backup;
  const uncertain = c.issues > 0 || c.failedRoots > 0;
  return (
    <>
      <details className="au-coverage">
        <summary>
          <span className="au-coverage-status">
            <svg
              className={
                backup && !c.indexing
                  ? "au-coverage-icon is-verified"
                  : "au-coverage-icon"
              }
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <circle
                cx="10"
                cy="10"
                r="8"
                stroke="currentColor"
                strokeWidth="1.4"
              />
              {backup && !c.indexing && (
                <path
                  d="m6 10 2.5 2.5L14 7"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
            <span>
              <strong>
                {c.indexing
                  ? "Recovering history…"
                  : backup
                    ? "Backed up to Matrix"
                    : "Indexed on your Matrix computer"}
              </strong>
              <small>
                {c.indexing
                  ? "Older sessions are still being indexed."
                  : backup
                    ? `${formatBytes(backup.verifiedBytes)} · ${date(backup.verifiedAt)}`
                    : "This view does not report backup verification."}
              </small>
            </span>
          </span>
          <span className="au-coverage-actions">
            {uncertain && (
              <span className="au-coverage-caution">
                Some usage is incomplete
              </span>
            )}
            <span className="au-coverage-toggle">
              Details{" "}
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="m4 6 4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </span>
        </summary>
        <CoverageMetadata history={history} />
      </details>
      <HistoryScope history={history} />
    </>
  );
}
export function HistoryScope({ history }: { history: UsageHistory }) {
  const c = history.coverage;
  return (
    <p className="au-history-scope">
      Recovered coding counters:{" "}
      {c.oldest ? date(c.oldest) : "start unavailable"} –{" "}
      {c.newest ? date(c.newest) : "end unavailable"}.
      {c.webHistory?.first && (
        <>
          {" "}
          Earlier web activity (since {date(c.webHistory.first)}) is shown
          separately without token counts.
        </>
      )}
    </p>
  );
}
function CoverageMetadata({ history }: { history: UsageHistory }) {
  const c = history.coverage,
    backup = c.backup;
  const uncertain = c.issues > 0 || c.failedRoots > 0;
  return (
    <div className="au-coverage-body">
      <dl className="au-coverage-grid">
        <div>
          <dt>Report updated</dt>
          <dd>{reportTime.format(new Date(c.indexedAt))} UTC</dd>
        </div>
        <div>
          <dt>Connected sources</dt>
          <dd>{c.machines.join(", ")}</dd>
        </div>
        <div>
          <dt>Recorded token history</dt>
          <dd>
            {c.oldest ? date(c.oldest) : "Unknown start"} –{" "}
            {c.newest ? date(c.newest) : "Unknown end"}
          </dd>
        </div>
        <div>
          <dt>Verified backup</dt>
          <dd>
            {backup
              ? `${number(backup.verifiedFiles)} files verified on Matrix · ${formatBytes(backup.verifiedBytes)}`
              : "Not reported in this view"}
          </dd>
        </div>
        <div>
          <dt>Recovered files</dt>
          <dd>
            {number(c.files)} files · {formatBytes(c.indexedBytes)} processed
          </dd>
        </div>
        {!!c.activityOnlySessions && (
          <div>
            <dt>Activity without token counters</dt>
            <dd>
              {number(c.activityOnlySessions)} sessions
              {c.oldestActivity ? ` · since ${date(c.oldestActivity)}` : ""}
            </dd>
          </div>
        )}
        {uncertain && (
          <div>
            <dt>Coverage gaps</dt>
            <dd>
              {number(c.issues)} partial or ambiguous records
              {c.failedRoots > 0
                ? ` · ${number(c.failedRoots)} folders could not be read`
                : ""}
              . Totals may be incomplete.
            </dd>
          </div>
        )}
        {!!c.preservedAgents?.length && (
          <div>
            <dt>Other histories preserved</dt>
            <dd>
              {c.preservedAgents.join(", ")}. Their token imports are pending.
            </dd>
          </div>
        )}
      </dl>
      {c.legacyActivity && (
        <p className="au-coverage-note">
          Earlier Claude activity ({c.legacyActivity.firstDay} –{" "}
          {c.legacyActivity.lastDay}) is kept separate from token totals to
          avoid counting overlapping history twice.
        </p>
      )}
    </div>
  );
}
export function WebHistoryDetails({ history }: { history: UsageHistory }) {
  if (!history.coverage.webHistory) return null;
  return (
    <article className="au-ledger">
      <div className="au-section-head">
        <div>
          <h3>{history.coverage.webHistory.provider} web history</h3>
          <p>
            {number(history.coverage.webHistory.conversations)} conversations ·{" "}
            {number(history.coverage.webHistory.messages)} messages
          </p>
        </div>
      </div>
      <p>
        {history.coverage.webHistory.first?.slice(0, 10)} –{" "}
        {history.coverage.webHistory.last?.slice(0, 10)} · Original account
        export backed up on Matrix.
      </p>
      <table>
        <thead>
          <tr>
            <th>Year</th>
            <th>Conversations</th>
            <th>Messages</th>
          </tr>
        </thead>
        <tbody>
          {history.coverage.webHistory.years.map((year) => (
            <tr key={year.year}>
              <td>{year.year}</td>
              <td>{number(year.conversations)}</td>
              <td>{number(year.messages)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        This export has no token or cost counters. Web activity is separate from
        coding-agent token totals.
      </p>
    </article>
  );
}
export function UsageModels({ summary }: { summary: UsageSummary }) {
  return (
    <article className="au-ledger">
      <div className="au-section-head">
        <div>
          <h3>Where your tokens go</h3>
          <p>Models and agents in the selected period</p>
        </div>
        <span>{summary.models.length} models</span>
      </div>
      <div className="au-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Model / agent</th>
              <th>Input</th>
              <th>Output</th>
              <th>Cache read / write</th>
              <th>API estimate</th>
            </tr>
          </thead>
          <tbody>
            {summary.models.slice(0, 30).map((row) => (
              <tr key={`${row.agent}:${row.model}`}>
                <td>
                  <strong>{row.model}</strong>
                  <small>{agentName(row.agent)}</small>
                </td>
                <td>{number(row.input)}</td>
                <td>{number(row.output)}</td>
                <td>
                  {number(row.cachedInput)} / {number(row.cacheWrite)}
                </td>
                <td>
                  {money(row.estimatedUsd)}
                  {row.unpriced > 0 && row.estimatedUsd !== null
                    ? " + unpriced"
                    : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {summary.models.length > 30 && <p>Showing the 30 most-used models.</p>}
    </article>
  );
}

export function UsageFooter({
  history,
  sources,
  eventCount,
  requests,
  issues,
  initialSourceLabel,
  zone,
  timeZone,
  onZoneChange,
}: {
  history?: UsageHistory;
  sources: number;
  eventCount: number;
  requests: number;
  issues: number;
  initialSourceLabel?: string;
  zone: string;
  timeZone: string;
  onZoneChange(value: string): void;
}) {
  return (
    <footer className="au-source">
      <span>
        {sources
          ? `${sources} selected files`
          : (initialSourceLabel ?? "Selected history only")}{" "}
        · {number(history ? requests : eventCount)} observed updates
        {issues
          ? ` · ${number(issues)} incomplete, conflicting or unsupported records`
          : ""}
      </span>
      <label>
        Reporting timezone{" "}
        <UsageSelect label="Reporting timezone" value={zone} disabled={Boolean(history)} onChange={onZoneChange} options={[...new Set([timeZone,zone,"UTC","Europe/Stockholm","America/New_York","America/Los_Angeles"])].map(value=>({value,label:value}))}/>
      </label>
      <p>
        {history
          ? "Recovered history from indexed sources. Missing or deleted history is unavailable; blank dates do not prove no usage. "
          : "Partial local history; selected data clears on reload. "}
        Estimates use a pricing snapshot (9 Nov 2026), exclude unpriced models,
        unknown cache TTLs and long-context updates, and are not your bill or
        subscription usage.
      </p>
    </footer>
  );
}

export function UsageSummaryCards({
  summary,
  days,
}: {
  summary: UsageSummary;
  days: number;
}) {
  return (
    <div className="au-cards">
      <article>
        <span>Recorded tokens</span>
        <strong data-testid="token-total">{number(summary.tokens)}</strong>
        <small>
          {number(summary.input)} input · {number(summary.output)} output
        </small>
      </article>
      <article>
        <span>API cost estimate</span>
        <strong className="au-cost-value">{money(summary.estimatedUsd)}</strong>
        <small>
          {summary.unpriced
            ? `${number(summary.unpriced)} updates unpriced · partial subtotal`
            : "USD list-price equivalent"}
        </small>
      </article>
      <article>
        <span>Sessions</span>
        <strong>{number(summary.sessions)}</strong>
        <small>Across selected agent histories</small>
      </article>
      <article>
        <span>Active days</span>
        <strong>
          {summary.activeDays}
          <em> / {days}</em>
        </strong>
        <small>
          {number(summary.cachedInput + summary.cacheWrite)} cache tokens
        </small>
      </article>
    </div>
  );
}
