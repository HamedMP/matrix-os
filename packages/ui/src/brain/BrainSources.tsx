"use client";

import { useState } from "react";
import { BrainButton } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import {
  BRAIN_RECEIPTS_SHOWN, BRAIN_SOURCE_KIND_LABELS, brainDay, brainNextActionText, brainSyncText,
} from "./brain-format.js";
import type { BrainJobView, BrainSourceView } from "./brain-types.js";
import { BrainBadge, BrainError, BrainJobProgress, BrainView, type BrainScreenProps } from "./brain-ui.js";
import { BrainReceipts, BrainRepositoryCard } from "./BrainRepositoryCard.js";
import { BrainSourceConnect } from "./BrainSourceConnect.js";
import {
  BRAIN_JOBS_READ_MAX, brainActiveJobs, brainStartOrRun, useBrainJob, useBrainJobResume, type BrainActiveJobs,
} from "./use-brain-job.js";
import { useBrainAction, useBrainLoad } from "./use-brain-load.js";

const SOURCE_RUN_LABELS: Readonly<Record<string, string>> = { sync: "Sync" };
const NO_JOBS: ReadonlyMap<string, BrainJobView> = new Map();

/**
 * Sources: the project's repository (sync, find claims, receipts) and every other connected source. The project's
 * recent jobs are read once on open, so a card follows a run that is still going (after a reload or a reopen); a
 * gateway without the jobs route reads as none.
 */
export function BrainSources({ api, projectId }: BrainScreenProps) {
  const jobs = useBrainLoad(async () => brainActiveJobs(await api.jobs(projectId, BRAIN_JOBS_READ_MAX)), "jobs");
  const active: BrainActiveJobs = jobs.state.status === "ready" ? jobs.state.data
    : jobs.state.status === "error" ? NO_JOBS : null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <BrainRepositoryCard api={api} projectId={projectId} active={active} />
      <OtherSources api={api} projectId={projectId} active={active} />
    </div>
  );
}

function OtherSources({ api, projectId, active }: Pick<BrainScreenProps, "api" | "projectId"> & {
  readonly active: BrainActiveJobs;
}) {
  const list = useBrainLoad(() => api.sources(projectId), "sources");
  return (
    <section aria-label="Other sources" className="grid gap-3">
      <h2 className="text-base font-semibold">Other sources</h2>
      <BrainView state={list.state} label="Loading sources..." onRetry={list.reload}>
        {(view) => {
          const others = view.items.filter((source) => source.kind !== "git");
          return (
            <div className="grid gap-3">
              {others.length === 0 ? <p className="text-sm text-muted-foreground">No other sources yet.</p> : (
                <ul aria-label="Connected sources" className="grid gap-3">
                  {others.map((source) => (
                    <SourceRow key={source.sourceId} api={api} projectId={projectId} source={source} active={active}
                      onChanged={list.reload} />
                  ))}
                </ul>
              )}
              <BrainSourceConnect api={api} projectId={projectId} kinds={view.kinds} onConnected={list.reload} />
            </div>
          );
        }}
      </BrainView>
    </section>
  );
}

function SourceRow({ api, projectId, source, active, onChanged }: Pick<BrainScreenProps, "api" | "projectId"> & {
  readonly source: BrainSourceView; readonly active: BrainActiveJobs; readonly onChanged: () => void;
}) {
  const action = useBrainAction();
  const [message, setMessage] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [showReceipts, setShowReceipts] = useState(false);
  const receipts = useBrainLoad(() => api.sourceReceipts(projectId, source.sourceId, BRAIN_RECEIPTS_SHOWN),
    showReceipts ? source.sourceId : null);
  const paused = source.status !== "active";
  // A sync adds a receipt under the same key, so an open list is reloaded (a hidden one loads nothing).
  const changed = () => { onChanged(); receipts.reload(); };
  const job = useBrainJob({
    poll: (jobId) => api.job(projectId, jobId), cancel: (jobId) => api.cancelJob(projectId, jobId),
    onFinished: changed,
  });
  useBrainJobResume(job, active, { [`sync:${source.sourceId}`]: "sync" });
  const busy = action.busy !== null || job.running;
  // Syncs run in the background like the repository's; a gateway without jobs syncs directly.
  const sync = () => action.run("sync", () => brainStartOrRun(api, projectId, { kind: "sync", sourceId: source.sourceId },
    async () => brainSyncText(await api.syncSource(projectId, source.sourceId))), (outcome) => {
    if (!outcome.started) { setMessage(outcome.text); changed(); return; }
    setMessage("");
    job.start("sync", outcome.view);
  });
  return (
    <li className={`grid gap-2 rounded-md border p-3 ${BRAIN_TONE.border}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{source.label}</span>
        <BrainBadge>{BRAIN_SOURCE_KIND_LABELS[source.kind]}</BrainBadge>
        <BrainBadge tone={paused ? "warn" : "good"}>{source.status}</BrainBadge>
        {source.lastSync && (
          <span className="text-xs text-muted-foreground">
            Last sync {source.lastSync.status} {brainDay(source.lastSync.startedAt)}
            {source.lastSync.errorCode ? `. ${brainNextActionText(source.lastSync.nextAction)}` : ""}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <BrainButton size="sm" disabled={busy || paused} onClick={sync}>
          {action.busy === "sync" || job.running ? "Syncing..." : "Sync now"}
        </BrainButton>
        <BrainButton size="sm" variant="outline" disabled={busy}
          onClick={() => action.run("status", () => api.updateSource(projectId, source.sourceId, {
            expectedRevision: source.revision, status: paused ? "active" : "paused",
          }), changed)}>
          {paused ? "Resume" : "Pause"}
        </BrainButton>
        <BrainButton size="sm" variant="outline" aria-expanded={showReceipts} onClick={() => setShowReceipts(!showReceipts)}>
          {showReceipts ? "Hide syncs" : "Show syncs"}
        </BrainButton>
        {confirming ? (
          <>
            <BrainButton size="sm" variant="destructive" disabled={busy}
              onClick={() => action.run("remove", () => api.removeSource(projectId, source.sourceId, source.revision), onChanged)}>
              Disconnect for good
            </BrainButton>
            <BrainButton size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</BrainButton>
          </>
        ) : <BrainButton size="sm" variant="ghost" onClick={() => setConfirming(true)}>Disconnect</BrainButton>}
      </div>
      <BrainJobProgress job={job} labels={SOURCE_RUN_LABELS} />
      {message !== "" && <p role="status" className="text-sm">{message}</p>}
      {action.error && <BrainError error={action.error} onRetry={onChanged} />}
      <BrainView state={receipts.state} label="Loading syncs..." onRetry={receipts.reload}>
        {(view) => <BrainReceipts receipts={view.receipts} />}
      </BrainView>
    </li>
  );
}
