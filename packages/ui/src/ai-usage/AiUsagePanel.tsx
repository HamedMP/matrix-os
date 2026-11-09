"use client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  mergeUsageEvents,
  summarizeUsage,
  usageDay,
  type UsageAgent,
  type UsageEvent,
} from "@matrix-os/contracts/ai-usage";
import { readUsageFiles } from "./read-files";
import { number, money, agentName } from "./format";
import { UsageHeatmap } from "./UsageHeatmap";
export function AiUsagePanel({
  initialEvents = [],
  initialIssues = 0,
  initialSourceLabel,
  allowFileSelection = true,
  now = new Date(),
  timeZone = "UTC",
}: {
  initialEvents?: UsageEvent[];
  initialIssues?: number;
  initialSourceLabel?: string;
  allowFileSelection?: boolean;
  now?: Date;
  timeZone?: string;
} = {}) {
  const [events, setEvents] = useState(initialEvents),
    [agent, setAgent] = useState<UsageAgent | "">(""),
    [days, setDays] = useState(365);
  const [zone, setZone] = useState(timeZone);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [issues, setIssues] = useState(initialIssues),
    [sources, setSources] = useState(0);
  const generation = useRef<AbortController | null>(null);
  useEffect(() => () => generation.current?.abort(), []);
  const endDay = usageDay(now.toISOString(), zone);
  const summary = useMemo(
    () =>
      summarizeUsage(events, {
        timeZone: zone,
        endDay,
        days,
        agent: agent || undefined,
      }),
    [events, zone, endDay, days, agent],
  );
  async function selectFiles(files: File[]) {
    if (!files?.length) return;
    generation.current?.abort();
    const controller = new AbortController();
    generation.current = controller;
    setBusy(true);
    setError("");
    try {
      const result = await readUsageFiles(files, controller.signal);
      controller.signal.throwIfAborted();
      const merged = mergeUsageEvents([...events, ...result.events]);
      setEvents(merged.events);
      setIssues((value) => value + result.issues + merged.conflicts);
      setSources((value) => value + files.length);
    } catch (cause: unknown) {
      if (!controller.signal.aborted) {
        console.warn(
          "Usage files unavailable",
          cause instanceof Error ? cause.name : "UnknownError",
        );
        setError(
          "Could not read these files. Choose Claude/Codex JSONL or a Matrix usage export, up to 64 MB per file and 256 MB per selection.",
        );
      }
    } finally {
      // react-doctor-disable-next-line react-doctor/no-loading-flag-reset-outside-finally -- this is the operation finally block; stale generations must not clear a newer load
      if (generation.current === controller) setBusy(false);
    }
  }
  function clear() {
    try {
      generation.current?.abort();
      setEvents([]);
      setSources(0);
      setIssues(0);
      setError("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ai-usage ph-no-capture" aria-label="Personal AI usage">
      <header className="au-header">
        <div>
          <div className="au-eyebrow">
            YOUR WORK WITH AI <span>PRIVATE · POC</span>
          </div>
          <h2>AI usage</h2>
          <p>A little perspective on everything you build.</p>
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
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
        </div>
        <span>◉ Only you can see this</span>
      </div>
      {error && (
        <p role="alert" className="au-notice">
          {error}
        </p>
      )}
      <div className="au-cards">
        <article>
          <span>Total tokens</span>
          <strong data-testid="token-total">{number(summary.tokens)}</strong>
          <small>
            {number(summary.input)} input · {number(summary.output)} output
          </small>
        </article>
        <article>
          <span>API cost estimate</span>
          <strong>
            {money(summary.estimatedUsd)}
            {summary.unpriced > 0 && summary.estimatedUsd !== null ? " +" : ""}
          </strong>
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
      <UsageHeatmap
        key={`${agent}:${days}:${zone}`}
        summary={summary}
        days={days}
        endDay={endDay}
      />
      {!events.length && (
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
      {!!events.length && (
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
          {summary.models.length > 30 && (
            <p>Showing the 30 most-used models.</p>
          )}
        </article>
      )}
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
      <footer className="au-source">
        <span>
          {sources
            ? `${sources} selected files`
            : events.length && initialSourceLabel
              ? initialSourceLabel
              : "Selected history only"}{" "}
          · {number(events.length)} observed updates
          {issues
            ? ` · ${number(issues)} incomplete, conflicting or unsupported records`
            : ""}
        </span>
        <label>
          Reporting timezone{" "}
          <select
            aria-label="Reporting timezone"
            value={zone}
            onChange={(e) => {
              setZone(e.target.value);
            }}
          >
            {[
              ...new Set([
                timeZone,
                "UTC",
                "Europe/Stockholm",
                "America/New_York",
                "America/Los_Angeles",
              ]),
            ].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </label>
        <p>
          Partial local history. Estimates use a limited pricing snapshot (9 Nov
          2026), exclude unpriced models, unknown cache TTLs and long-context
          updates, and are not your bill or subscription usage. Selected data
          clears on reload.
        </p>
      </footer>
    </section>
  );
}
