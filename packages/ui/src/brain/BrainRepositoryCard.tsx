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
  BrainBadge, BrainConfirm, BrainEmpty, BrainError, BrainJobProgress, BrainView, type BrainScreenProps,
} from "./brain-ui.js";
import { brainStartOrRun, useBrainSlotJob, type BrainActiveJobs } from "./use-brain-job.js";
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
const RUN_NAMES = Object.keys(RUN_LABELS) as RunName[];

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
  const onFinished = (name: string) => { git.reload(); if (name === "model") budget.reload(); };
  // One job per slot, so runs found on open show side by side; the buttons stay off until every one has ended.
  const jobs = {
    sync: useBrainSlotJob(api, projectId, active, "sync:git", "sync", onFinished),
    rules: useBrainSlotJob(api, projectId, active, "extract:rules", "rules", onFinished),
    model: useBrainSlotJob(api, projectId, active, "extract:model", "model", onFinished),
  };
  const busy = action.busy !== null || RUN_NAMES.some((name) => jobs[name].running);
  const budgetText = brainModelBudgetText(spend);
  const spendText = brainModelSpendText(spend);
  // Runs are polled background jobs; a gateway without the jobs route or that kind of job runs them directly.
  const runInBackground = (name: RunName, direct: () => Promise<string>) => action.run(name,
    () => brainStartOrRun(api, projectId, RUN_JOBS[name], direct), (outcome) => {
    if (!outcome.started) { done(outcome.text); return; }
    setMessage("");
    jobs[name].start(name, outcome.view);
  });
  return (
    <section aria-label="Repository" className="grid gap-3">
      <h2 className="text-base font-semibold">Repository</h2>
      <BrainView state={git.state} label="Loading the repository..." onRetry={git.reload}>
        {(view) => view.source === null ? (
          <BrainEmpty title="This project's repository is not connected.">
            <p className="mb-2">Connect it so the brain can read its commits, pull requests and specs.</p>
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
            {/* relative: the model confirm floats over what follows, the width of this row. */}
            <div className="relative flex flex-wrap gap-2">
              <BrainButton size="sm" disabled={busy}
                onClick={() => runInBackground("sync", async () => brainSyncText(await api.syncGit(projectId)))}>
                {action.busy === "sync" ? "Syncing..." : "Sync now"}
              </BrainButton>
              <BrainButton size="sm" variant="outline" disabled={busy}
                onClick={() => runInBackground("rules",
                  async () => brainExtractText(await api.extract(projectId, { extractor: "rules" })))}>
                {action.busy === "rules" ? "Reading..." : "Find claims"}
              </BrainButton>
              <BrainConfirm open={confirmModel} onClose={() => setConfirmModel(false)} label="Read with the model"
                trigger={(
                  <BrainButton size="sm" variant="outline" disabled={busy} aria-haspopup="dialog" aria-expanded={confirmModel}
                    onClick={() => { if (!confirmModel) budget.reload(); setConfirmModel(!confirmModel); }}>
                    {action.busy === "model" ? "Reading..." : "Find claims with the model"}
                  </BrainButton>
                )}>
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
              </BrainConfirm>
            </div>
            {spendText !== "" && <p className="text-xs text-muted-foreground">{spendText}</p>}
            {RUN_NAMES.map((name) => <BrainJobProgress key={name} job={jobs[name]} labels={RUN_LABELS} />)}
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
