"use client";
import React, { useMemo, useState } from "react";
import {
  summarizeUsage,
  usageDay,
  type UsageAgent,
  type UsageEvent,
  type UsageHistory,
} from "@matrix-os/contracts/ai-usage";
import { useUsageFiles } from "./use-usage-files";

import {
  HistoryCoverage,
  WebHistoryDetails,
  UsageModels,
  UsageFooter,
  UsageSummaryCards,
} from "./UsageDetails";
import { UsageHeatmap } from "./UsageHeatmap";
export function AiUsagePanel({
  initialEvents = [],
  initialIssues = 0,
  history,
  initialSourceLabel,
  allowFileSelection = true,
  now = new Date(),
  timeZone = "UTC",
}: {
  initialEvents?: UsageEvent[];
  initialIssues?: number;
  history?: UsageHistory;
  initialSourceLabel?: string;
  allowFileSelection?: boolean;
  now?: Date;
  timeZone?: string;
} = {}) {
  const { events, busy, error, issues, sources, selectFiles, clear } =
    useUsageFiles(initialEvents, initialIssues);
  const [agent, setAgent] = useState<UsageAgent | "">(""),
    [range, setRange] = useState(history ? "all" : "365");
  const [zone, setZone] = useState(history?.timeZone ?? timeZone);
  const report = history?.reports.find(
    (r) => r.id === range && r.agent === agent,
  );
  const days = report?.days ?? Number(range);
  const endDay = report?.endDay ?? usageDay(now.toISOString(), zone);
  const computed = useMemo(
    () =>
      summarizeUsage(events, {
        timeZone: zone,
        endDay,
        days: report ? 1 : days,
        agent: agent || undefined,
      }),
    [events, zone, endDay, days, agent, report],
  );
  const summary = report?.summary ?? computed;
  const hasUsage = summary.requests > 0;
  return (
    <section className="ai-usage ph-no-capture" aria-label="Personal AI usage">
      <header className="au-header">
        <div>
          <h2>AI usage</h2>
          <p>Your coding activity, across agents and computers.</p>
        </div>
        {allowFileSelection && (
          <div className="au-actions">
            <button type="button" onClick={clear}>
              Clear
            </button>
            <label className="au-primary">
              {busy ? "Reading locally…" : "Add usage files"}
              <input
                aria-label="Choose usage files"
                type="file"
                accept=".jsonl,.json"
                multiple
                disabled={busy}
                onChange={(e) => {
                  void selectFiles(Array.from(e.currentTarget.files ?? []));
                  e.currentTarget.value = "";
                }}
              />
            </label>
          </div>
        )}
      </header>
      <div className="au-toolbar">
        <div className="au-filter">
          <select
            aria-label="Coding agent"
            value={agent}
            onChange={(e) => setAgent(e.target.value as UsageAgent | "")}
          >
            <option value="">All agents</option>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <select
            aria-label="Date range"
            value={range}
            onChange={(e) => setRange(e.target.value)}
          >
            {history ? (
              history.reports
                .filter((r) => r.agent === "")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))
            ) : (
              <>
                <option value={7}>Last 7 days</option>
                <option value={30}>Last 30 days</option>
                <option value={90}>Last 90 days</option>
                <option value={365}>Last year</option>
              </>
            )}
          </select>
        </div>
        <span>◉ Only you can see this</span>
      </div>
      {error && (
        <p role="alert" className="au-notice">
          {error}
        </p>
      )}
      {history && <HistoryCoverage history={history} />}
      <UsageSummaryCards summary={summary} days={days} />
      <UsageHeatmap
        key={`${agent}:${days}:${zone}`}
        summary={summary}
        days={days}
        endDay={endDay}
      />
      {!hasUsage && (
        <div className="au-empty">
          <span>↗</span>
          <h3>Your AI activity, in one place.</h3>
          <p>
            {allowFileSelection
              ? "Add Claude Code or Codex transcripts, or a usage export from your Matrix computer. Your files are read locally and are never uploaded by this panel."
              : "No recorded usage found in the standard Claude Code and Codex folders. Refresh after an agent run."}
          </p>
        </div>
      )}
      {hasUsage && <UsageModels summary={summary} />}
      {history?.coverage.webHistory && <WebHistoryDetails history={history} />}
      <div className="au-bottom">
        <div>
          <h3>Better habits start with visibility.</h3>
          <p>
            Workflow insights and suggested improvements to your agent
            instructions are planned next.
          </p>
        </div>
        <span>COMING NEXT</span>
      </div>
      <UsageFooter
        history={history}
        sources={sources}
        eventCount={events.length}
        requests={summary.requests}
        issues={issues}
        initialSourceLabel={initialSourceLabel}
        zone={zone}
        timeZone={timeZone}
        onZoneChange={setZone}
      />
    </section>
  );
}
