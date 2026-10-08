"use client";

import { useState } from "react";
import { brainRunMayContinue } from "./brain-client.js";
import { BrainButton } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import {
  BRAIN_RECEIPTS_SHOWN, brainCountsText, brainDay, brainExtractText, brainModelBudgetText, brainModelSpendText,
  brainNextActionText, brainSyncText,
} from "./brain-format.js";
import type { BrainExtractView, BrainJobStartInput, BrainReceiptView } from "./brain-types.js";
import {
  BrainBadge, BrainEmpty, BrainError, BrainJobProgress, BrainView, type BrainScreenProps,
} from "./brain-ui.js";
import { brainStartOrRun, useBrainJob, useBrainJobResume, type BrainActiveJobs } from "./use-brain-job.js";
import { useBrainAction, useBrainLoad } from "./use-brain-load.js";

const MODEL_RUN_NOTE = "Read with the model? This sends this project's pull requests, commits and specs to Anthropic "
  + "and can cost up to the per-run limit.";
/** Gateway proxies end a request at 30 s, before a model run does; the run itself goes on. */
const MODEL_RUN_PENDING = "The model run may still be finishing; its claims will appear in Decisions, Commitments and "
  + "Risks. Running it again now says claims are already being read.";

/** A direct model run (no jobs route) cut short on its way back may still be going; only that is worded as pending. */
async function directModelRun(run: () => Promise<BrainExtractView>): Promise<string> {
  try {
    return brainExtractText(await run());
  } catch (error: unknown) {
    if (!brainRunMayContinue(error)) throw error;
    return MODEL_RUN_PENDING;
  }
}

type RunName = "sync" | "rules" | "model";
const RUN_LABELS: Readonly<Record<RunName, string>> = {
  sync: "Sync", rules: "Finding claims", model: "Finding claims with the model",
};
const RUN_JOBS: Readonly<Record<RunName, BrainJobStartInput>> = {
  sync: { kind: "sync" }, rules: { kind: "extract", extractor: "rules" }, model: { kind: "extract", extractor: "model" },
};
/** The repository card's job slots (brainJobKey) and the run name each is shown as. */
const REPOSITORY_SLOTS: Readonly<Record<string, RunName>> = {
  "sync:git": "sync", "extract:rules": "rules", "extract:model": "model",
};

/** The project's repository: connect, sync, find claims (by rules or, after a confirm, the model) and recent syncs. */
export function BrainRepositoryCard({ api, projectId, active }: Pick<BrainScreenProps, "api" | "projectId"> & {
  readonly active: BrainActiveJobs;
}) {
  const git = useBrainLoad(() => api.gitReceipts(projectId, BRAIN_RECEIPTS_SHOWN), "git");
  const action = useBrainAction();
  const [message, setMessage] = useState("");
  const [confirmModel, setConfirmModel] = useState(false);
  const done = (text: string) => { setMessage(text); git.reload(); };
  // The model budget (one claim page): read on open, again when a model run is confirmed and after it ends.
  const budget = useBrainLoad(() => api.claims(projectId, { limit: 1 }), "budget");
  const spend = budget.state.status === "ready" ? budget.state.data.modelSpend : null;
  const job = useBrainJob({
    poll: (jobId) => api.job(projectId, jobId), cancel: (jobId) => api.cancelJob(projectId, jobId),
    onFinished: (name) => { git.reload(); if (name === "model") budget.reload(); },
  });
  useBrainJobResume(job, active, REPOSITORY_SLOTS);
  const busy = action.busy !== null || job.running;
  const budgetText = brainModelBudgetText(spend);
  const spendText = brainModelSpendText(spend);
  // Runs go to the background (a job polled until it ends); a gateway without the jobs route, or without that kind
  // of job, runs them directly as before.
  const runInBackground = (name: RunName, direct: () => Promise<string>) => action.run(name,
    () => brainStartOrRun(api, projectId, RUN_JOBS[name], direct), (outcome) => {
    if (!outcome.started) { done(outcome.text); return; }
    setMessage("");
    job.start(name, outcome.view);
  });
  return (
    <section aria-label="Repository" className="grid gap-3">
      <h2 className="text-base font-semibold">Repository</h2>
      <BrainView state={git.state} label="Loading the repository..." onRetry={git.reload}>
        {(view) => view.source === null ? (
          <BrainEmpty title="This project's repository is not connected.">
            <BrainButton size="sm" disabled={busy}
              onClick={() => action.run("connect", () => api.registerGitSource(projectId, {}), () => done("Repository connected. Sync it next."))}>
              Connect repository
            </BrainButton>
          </BrainEmpty>
        ) : (
          <div className={`grid gap-3 rounded-md border p-3 ${BRAIN_TONE.border}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{view.source.label}</span>
              <BrainBadge tone={view.source.status === "active" ? "good" : "warn"}>{view.source.status}</BrainBadge>
              {view.source.webBase && <span className="truncate text-xs text-muted-foreground">{view.source.webBase}</span>}
            </div>
            <div className="flex flex-wrap gap-2">
              <BrainButton size="sm" disabled={busy}
                onClick={() => runInBackground("sync", async () => brainSyncText(await api.syncGit(projectId)))}>
                {action.busy === "sync" ? "Syncing..." : "Sync now"}
              </BrainButton>
              <BrainButton size="sm" variant="outline" disabled={busy}
                onClick={() => runInBackground("rules",
                  async () => brainExtractText(await api.extract(projectId, { extractor: "rules" })))}>
                {action.busy === "rules" ? "Reading..." : "Find claims"}
              </BrainButton>
              <BrainButton size="sm" variant="outline" disabled={busy || confirmModel}
                onClick={() => { setConfirmModel(true); budget.reload(); }}>
                {action.busy === "model" ? "Reading..." : "Find claims with the model"}
              </BrainButton>
            </div>
            {confirmModel && (
              <div role="group" aria-label="Read with the model" className={`grid gap-2 rounded-md p-3 text-sm ${BRAIN_TONE.panel}`}>
                <p>{MODEL_RUN_NOTE}</p>
                {budgetText !== "" && <p className="text-muted-foreground">{budgetText}</p>}
                <div className="flex flex-wrap gap-2">
                  <BrainButton size="sm" disabled={busy} onClick={() => {
                    setConfirmModel(false);
                    runInBackground("model", async () => {
                      const text = await directModelRun(() => api.extract(projectId, { extractor: "model" }));
                      budget.reload();
                      return text;
                    });
                  }}>Read with the model</BrainButton>
                  <BrainButton size="sm" variant="ghost" onClick={() => setConfirmModel(false)}>Cancel</BrainButton>
                </div>
              </div>
            )}
            {spendText !== "" && <p className="text-xs text-muted-foreground">{spendText}</p>}
            <BrainJobProgress job={job} labels={RUN_LABELS} />
            <BrainReceipts receipts={view.receipts} />
          </div>
        )}
      </BrainView>
      {message !== "" && <p role="status" className="text-sm">{message}</p>}
      {action.error && <BrainError error={action.error} />}
    </section>
  );
}

/** The recent syncs of a source, newest first. */
export function BrainReceipts({ receipts }: { readonly receipts: readonly BrainReceiptView[] }) {
  if (receipts.length === 0) return <p className="text-xs text-muted-foreground">Never synced.</p>;
  return (
    <ul aria-label="Recent syncs" className="grid gap-1 text-xs">
      {receipts.slice(0, BRAIN_RECEIPTS_SHOWN).map((receipt) => (
        <li key={receipt.receiptId} className="flex flex-wrap items-center gap-2">
          <BrainBadge tone={receipt.status === "succeeded" ? "good" : receipt.status === "running" ? "plain" : "warn"}>
            {receipt.status}
          </BrainBadge>
          <time dateTime={receipt.startedAt}>{brainDay(receipt.startedAt)}</time>
          <span className="text-muted-foreground">{brainCountsText(receipt.counts)}</span>
          {receipt.errorCode && <span className="text-muted-foreground">{brainNextActionText(receipt.nextAction)}</span>}
        </li>
      ))}
    </ul>
  );
}
