"use client";
import { useEffect, useId, useRef, useState } from "react";
import { chatUsageGroups, type ChatUsageClient, type ChatUsageGroup, type ChatUsagePolicy, type ChatUsageSummary } from "./client.js";

const ERROR = "Chat usage is unavailable. Retry when this computer is connected and signed in.";
const REPORT_ERROR = "Chat usage report is unavailable. Retry to load the report.";
const number = (value: number) => value.toLocaleString();
function known(value: number | null, unknown: number, currency = false) {
  if (value === null) return "Unknown";
  const formatted = currency ? new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 6 }).format(value) : number(value);
  return `${formatted} known${unknown ? ` · ${number(unknown)} unknown` : ""}`;
}

export function ChatUsagePanel(props: { client: ChatUsageClient; identityKey: string }) {
  // Replacing a runtime/account unmounts all old state before any new response can render.
  return <OwnerChatUsagePanel key={props.identityKey} client={props.client} />;
}
function OwnerChatUsagePanel({ client }: { client: ChatUsageClient }) {
  const title = useId(); const consentId = useId(); const deleteTitle = useId();
  const [policy, setPolicy] = useState<ChatUsagePolicy | null>(null);
  const [summary, setSummary] = useState<ChatUsageSummary | null>(null);
  const [group, setGroup] = useState<ChatUsageGroup>("taskFamily");
  const [sample, setSample] = useState(1000);
  const [consent, setConsent] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(true);
  const [policyError, setPolicyError] = useState(false);
  const [reportError, setReportError] = useState(false);
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | null>(null);
  const policyReadVersion = useRef(0);
  const reportReadVersion = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => { controller.abort(); lifetime.current = null; };
  }, [client]);
  useEffect(() => {
    const controller = new AbortController();
    const policyVersion = ++policyReadVersion.current; const reportVersion = ++reportReadVersion.current;
    setPolicyLoading(true); setReportLoading(true); setPolicyError(false); setReportError(false); setActionError(false); setSummary(null);
    // Policy must settle independently: report availability cannot prevent owners from stopping collection.
    void client.policy(controller.signal).then(nextPolicy => {
      if (controller.signal.aborted || policyReadVersion.current !== policyVersion) return;
      setPolicy(nextPolicy); setSample(nextPolicy.sampleRateBps); setPolicyLoading(false);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted || policyReadVersion.current !== policyVersion) return;
      if (!(failure instanceof Error)) console.warn("[chat-usage] Policy response unavailable");
      setPolicyError(true); setPolicyLoading(false);
    });
    void client.summary(group, controller.signal).then(nextSummary => {
      if (controller.signal.aborted || reportReadVersion.current !== reportVersion) return;
      setSummary(nextSummary); setReportLoading(false);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted || reportReadVersion.current !== reportVersion) return;
      if (!(failure instanceof Error)) console.warn("[chat-usage] Report response unavailable");
      setReportError(true); setReportLoading(false);
    });
    return () => { controller.abort(); };
  }, [client, group, revision]);

  async function mutate(action: "enable" | "stop" | "delete") {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busy || !policy || (action === "enable" && !consent)) return;
    setBusy(true); setActionError(false); setDeleted(false);
    try {
      if (action === "delete") {
        await client.deleteData(controller.signal);
        if (controller.signal.aborted || lifetime.current !== controller) return;
        // Clear only after the authenticated server confirmed the deletion.
        policyReadVersion.current++; reportReadVersion.current++; setSummary(null); setPolicy({ ...policy, enabled: false });
        setDeleted(true); setConsent(false); setConfirmDelete(false); setPolicyLoading(false); setReportLoading(false); setPolicyError(false); setReportError(false);
      } else {
        const next = await client.configure(action === "enable"
          ? { enabled: true, sampleRateBps: sample, disclosureVersion: "chat-usage-v1" }
          : { enabled: false, sampleRateBps: policy.sampleRateBps }, controller.signal);
        if (controller.signal.aborted || lifetime.current !== controller) return;
        // A pending report may still complete. Only an older policy read is superseded by this write.
        policyReadVersion.current++; setPolicy(next); setSample(next.sampleRateBps); setConsent(false); setPolicyLoading(false); setPolicyError(false);
      }
    } catch (failure: unknown) {
      if (controller.signal.aborted || lifetime.current !== controller) return;
      if (!(failure instanceof Error)) console.warn("[chat-usage] Settings action unavailable");
      setActionError(true);
    } finally {
      if (!controller.signal.aborted && lifetime.current === controller) setBusy(false);
    }
  }

  const totals = summary?.buckets.reduce((acc, row) => ({ generations: acc.generations + row.generations,
    sampled: acc.sampled + row.sampled, classified: acc.classified + row.classified }), { generations: 0, sampled: 0, classified: 0 });
  const cell = { padding: "8px", textAlign: "left" as const, verticalAlign: "top" as const, borderBottom: "1px solid var(--matrix-ap-border)", overflowWrap: "anywhere" as const };
  return <div className="matrix-agents-providers" style={{ marginTop: 24 }}>
    <section className="matrix-ap-panel" aria-labelledby={title} aria-busy={policyLoading || busy}>
      <header className="matrix-ap-panel-head"><h2 id={title} style={{ margin: 0, fontSize: 16 }}>Chat usage</h2>
        {policy ? <span className="matrix-ap-status-chip">{policy.enabled ? "Collecting" : "Off"}</span> : null}</header>
      <p>Covers ordinary Matrix Pi Chat and Bots on this computer that use Matrix’s model broker. Other agents are outside this report.</p>
      <p>Gmail, shared, imported and unknown contexts are excluded. Task tags and complexity are estimates, not quality scores.</p>
      {policyLoading || reportLoading ? <p role="status">{policyLoading ? "Loading Chat usage…" : "Loading Chat usage report…"}</p> : null}
      {policyError || reportError || actionError ? <div className="matrix-ap-notice" role="alert"><div>{policyError || actionError ? ERROR : REPORT_ERROR}</div>
        <button type="button" className="matrix-ap-button" disabled={busy} onClick={() => setRevision(value => value + 1)} aria-label="Retry Chat usage">Retry</button></div> : null}
      {policy ? <>
        <p>When enabled, sampled ordinary conversation text is sent transiently to Cloudflare Workers AI using Matrix AI credits.
          Model: <code style={{ overflowWrap: "anywhere" }}>{policy.modelId}</code>. Only tags and measured usage metadata are saved in your database. Reports cover up to 30 days.
          Expired metadata is hidden and removed by periodic cleanup while this computer is running. Separate backups and provider records are not erased by these controls.
          Conversation text is not saved by this analytics feature.</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "end", marginBottom: 12 }}>
          <label className="matrix-ap-field">Sampling<select aria-label="Sampling" value={sample} disabled={busy || policyLoading} onChange={event => { setSample(Number(event.target.value)); setConsent(false); }}>
            <option value={1000}>10%</option><option value={2500}>25%</option><option value={10000}>100%</option>
            {![1000, 2500, 10000].includes(sample) ? <option value={sample}>{sample / 100}% (saved)</option> : null}
          </select></label>
          {policy.enabled ? <button type="button" className="matrix-ap-button" disabled={busy} onClick={() => void mutate("stop")}>Stop Chat usage</button> : null}
          <button type="button" className="matrix-ap-button" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete Chat usage data</button>
        </div>
        <label htmlFor={consentId} style={{ display: "flex", alignItems: "start", gap: 8, marginBottom: 12 }}>
          <input id={consentId} type="checkbox" checked={consent} disabled={busy || policyLoading} onChange={event => setConsent(event.target.checked)} />
          <span>I agree to this processing of sampled ordinary Chat text for usage classification.</span>
        </label>
        <button type="button" className="matrix-ap-button matrix-ap-button-primary" disabled={!consent || busy || policyLoading} onClick={() => void mutate("enable")}>{policy.enabled ? "Update sampling" : "Enable Chat usage"}</button>
        <p>Stopping cancels pending classification and keeps retained reports. Deleting erases Chat usage data and turns collection off.</p>
      </> : null}
      {confirmDelete ? <div role="alertdialog" aria-labelledby={deleteTitle} className="matrix-ap-notice" style={{ flexWrap: "wrap" }}>
        <div><strong id={deleteTitle}>Delete Chat usage data?</strong><span>This erases retained usage reports and turns collection off. Your conversations are kept.</span></div>
        <button autoFocus type="button" className="matrix-ap-button" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button>
        <button type="button" className="matrix-ap-button matrix-ap-button-danger" disabled={busy} onClick={() => void mutate("delete")}>Confirm delete</button>
      </div> : null}
      {deleted ? <p role="status">Chat usage data deleted. Collection is off.</p> : null}
      <label className="matrix-ap-field" style={{ maxWidth: 240, marginTop: 16 }}>Group usage by<select aria-label="Group usage by" value={group} disabled={busy || reportLoading} onChange={event => { setGroup(event.target.value as ChatUsageGroup); setDeleted(false); }}>
        {Object.entries(chatUsageGroups).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
      {!reportLoading && summary ? <>
        <p>Last 7 days · Across shown groups: {number(totals!.classified)} classified · {number(totals!.sampled)} sampled · {number(totals!.generations)} recorded.</p>
        <p>Sampling rates can change over time. Unclassified generations have no estimated task tag. Known measurements exclude unknown values.</p>
        {summary.mayBeTruncated ? <p className="matrix-ap-notice">Showing the first {summary.groupLimit} groups by recorded generations. This report may omit other groups.</p> : null}
        {summary.buckets.length === 0 ? <p>No recorded generations</p> : <div role="region" aria-label="Chat usage report" tabIndex={0} style={{ maxWidth: "100%", overflowX: "auto" }}>
          <table aria-label={`Chat usage by ${chatUsageGroups[group]}`} style={{ width: "100%", fontSize: 12, borderCollapse: "collapse", minWidth: 700 }}>
            <thead><tr>{[chatUsageGroups[group], "Recorded / sampled / classified", "Input tokens", "Output tokens", "Cached input tokens", "Cost (USD)", "Mean latency"].map(name => <th key={name} scope="col" style={cell}>{name}</th>)}</tr></thead>
            <tbody>{summary.buckets.map((row, index) => <tr key={`${row.dimensions[group] ?? "unknown"}:${index}`}>
              <th scope="row" style={cell}>{row.dimensions[group] ?? (["taskFamily", "taskType", "complexity"].includes(group) ? "Unclassified" : "Unknown")}</th>
              <td style={cell}>{number(row.generations)} / {number(row.sampled)} / {number(row.classified)}</td>
              <td style={cell}>{known(row.inputTokens, row.unknownInputTokenGenerations)}</td>
              <td style={cell}>{known(row.outputTokens, row.unknownOutputTokenGenerations)}</td>
              <td style={cell}>{known(row.cachedInputTokens, row.unknownCachedInputTokenGenerations)}</td>
              <td style={cell}>{known(row.costUsd, row.unknownCostGenerations, true)}</td>
              <td style={cell}>{row.latencyMsMean === null ? "Unknown" : `${number(row.latencyMsMean)} ms known${row.unknownLatencyGenerations ? ` · ${row.unknownLatencyGenerations} unknown` : ""}`}</td>
            </tr>)}</tbody>
          </table>
        </div>}
      </> : null}
    </section>
  </div>;
}
