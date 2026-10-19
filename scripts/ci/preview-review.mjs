import { collectReviewPrs } from "./preview-review-recovery.mjs";
import { loadPreviewHistory } from "./preview-review-history.mjs";
import { originReadSnapshot } from "./preview-review-api.mjs";
import { publishReviewComments } from "./preview-review-report.mjs";
import {
  CLEANUP_PREFIX,
  cleanupStarted,
  CAPACITY,
  TTL_MS,
  TASK,
  ownedLease,
  sharedMachine,
  eligible,
  labeled,
  planQueue,
  needsDesktop,
  renderReview,
  repoName,
} from "./preview-review-model.mjs";
import { pages, request, upsertComment } from "./preview-review-api.mjs";
import { verifyIsolatedExecutionRun } from "./execution-origin.mjs";
const kinds = [
  ["web", "preview-vps.yml", "preview-web-v1"],
  ["desktop", "preview-desktop.yml", "preview-desktop-v1"],
];
const marker = (kind, r) =>
  `${kind} pr=${r.payload.pr} head=${r.payload.head} lease=${r.id}`;
const terminal = (run) => run?.status === "completed";

export async function reconcilePreviews({
  github,
  repo,
  platform,
  controllerSha,
  executionRef,
  owner,
  requestedPr,
  now = Date.now(),
}) {
  if (
    !/^user_[A-Za-z0-9]+$/.test(owner ?? "") ||
    repoName(repo) !== "hamedmp/matrix-os" ||
    executionRef !== `ci-execution/${controllerSha}`
  )
    throw new Error("Invalid preview controller scope");
  let machines = await platform.fleet();
  const open = await pages(github.rest.pulls.list, { ...repo, state: "open" });
  const history = await loadPreviewHistory({ github, repo, now });
  let leases = history.leases;
  const originApi = originReadSnapshot(github);
  if (new Set(leases.map((r) => r.payload.pr)).size !== leases.length)
    throw new Error(
      "Multiple active preview reservations require reconciliation",
    );
  for (const pr of open.filter(eligible)) {
    for (const name of ["preview-vps", "preview-bundle"]) {
      if (pr.labels.some((l) => l.name === name)) {
        await github.rest.issues.removeLabel({
          ...repo,
          issue_number: pr.number,
          name,
          request,
        });
        pr.labels = pr.labels.filter((l) => l.name !== name);
      }
    }
  }
  const prs = await collectReviewPrs({
    github, repo, open, leases, requestedPr, now,
  });
  const workflowRuns = new Map();
  const since = new Date(
    Math.min(now, ...leases.map((r) => Date.parse(r.created_at))) - 600000,
  ).toISOString();
  for (const [, workflow] of kinds) {
    workflowRuns.set(
      workflow,
      await pages(
        github.rest.actions.listWorkflowRuns,
        {
          ...repo,
          workflow_id: workflow,
          event: "workflow_dispatch",
          created: `>=${since}`,
        },
        "workflow_runs",
      ),
    );
  }
  const legacy = await pages(
    github.rest.actions.listWorkflowRuns,
    {
      ...repo,
      workflow_id: "preview-vps.yml",
      event: "pull_request",
      status: "in_progress",
    },
    "workflow_runs",
  );
  const queuedLegacy = await pages(
    github.rest.actions.listWorkflowRuns,
    {
      ...repo,
      workflow_id: "preview-vps.yml",
      event: "pull_request",
      status: "queued",
    },
    "workflow_runs",
  );
  // Legacy manual/isolated jobs have no source-bound lease marker. Drain them
  // before admitting new leases; inventing a PR identity could undercount capacity.
  let legacyDispatchDraining = false;
  for (const state of [
    "queued",
    "in_progress",
    "waiting",
    "pending",
    "requested",
  ]) {
    const live = await pages(
      github.rest.actions.listWorkflowRuns,
      {
        ...repo,
        workflow_id: "preview-vps.yml",
        event: "workflow_dispatch",
        status: state,
      },
      "workflow_runs",
    );
    if (live.some((r) => !/^preview-web-v1 pr=/.test(r.display_title ?? "")))
      legacyDispatchDraining = true;
    for (const run of live)
      if (!workflowRuns.get("preview-vps.yml").some((r) => r.id === run.id))
        workflowRuns.get("preview-vps.yml").push(run);
  }
  const pendingPrs = [];
  for (const run of [...legacy, ...queuedLegacy]) {
    if (
      run.event !== "pull_request" ||
      run.repository?.full_name?.toLowerCase() !== repoName(repo) ||
      run.head_repository?.full_name?.toLowerCase() !== repoName(repo) ||
      run.path !== ".github/workflows/preview-vps.yml"
    )
      throw new Error("Legacy preview run identity unavailable");
    for (const scope of run.pull_requests ?? []) {
      if (open.some((p) => p.number === scope.number && eligible(p))) {
        await cancel(run);
        pendingPrs.push(scope.number);
      }
    }
  }
  async function cancel(run) {
    try {
      await github.rest.actions.cancelWorkflowRun({
        ...repo,
        run_id: run.id,
        request,
      });
    } catch (error) {
      if (error?.status !== 409) throw error;
      const { data: live } = await github.rest.actions.getWorkflowRun({
        ...repo,
        run_id: run.id,
        request,
      });
      if (!terminal(live)) throw error;
    }
  }
  async function ownedRuns(row) {
    const found = [];
    for (const [kind, workflow, prefix] of kinds) {
      const matches = workflowRuns
        .get(workflow)
        .filter((run) => run.display_title === marker(prefix, row));
      for (const run of matches) {
        await verifyIsolatedExecutionRun(originApi, repo, run, {
          workflowPath: `.github/workflows/${workflow}`,
          controllerSha: row.payload.controllerSha,
        });
        found.push({ kind, run });
      }
    }
    return found;
  }
  async function status(row, state, description) {
    if (row.state === state && row.description === description) return;
    await github.rest.repos.createDeploymentStatus({
      ...repo,
      deployment_id: row.id,
      state,
      description,
      auto_inactive: false,
      request,
    });
    row.state = state;
    row.description = description;
  }
  // Stop writers first, then remove the disposable runtime. An accepted cancel
  // is not terminal proof; retain the slot until every owned run has stopped.
  const retiring = planQueue({
    requests: prs,
    reservations: leases,
    machines,
    pendingPrs,
    owner,
    now,
  }).cleanup;
  for (const row of retiring) {
    // This persisted barrier survives retries and label re-additions. Writers
    // must observe it before cancellation or provider deletion can begin.
    if (!cleanupStarted(row))
      await status(row, "in_progress", `${CLEANUP_PREFIX}Reconciling preview shutdown`);
    const pr = prs.find((p) => p.number === row.payload.pr);
    await upsertComment(
      github,
      repo,
      pr.number,
      renderReview({
        pr,
        head: pr.head.sha,
        status: "Stopping/expired; capacity held until cleanup is confirmed",
        expiresAt: row.payload.expiresAt,
        web: null,
      }),
    );
    try {
      if (
        Date.parse(row.payload.expiresAt) <= now &&
        pr.head.sha === row.payload.head &&
        labeled(pr)
      ) {
        await github.rest.issues.removeLabel({
          ...repo,
          issue_number: pr.number,
          name: "preview",
          request,
        });
        pr.labels = pr.labels.filter((l) => l.name !== "preview");
      }
      const runs = await ownedRuns(row);
      let draining = false;
      for (const { run } of runs) {
        if (!terminal(run)) {
          await cancel(run);
          draining = true;
        }
      }
      if (draining) {
        await status(row, "in_progress", `${CLEANUP_PREFIX}Stopping superseded preview jobs`);
        continue;
      }
      // An empty run set immediately after an ambiguous dispatch is not proof that
      // no job will start. A short reconciliation window prevents slot reuse races.
      const expected = row.payload.desktop ? 2 : 1;
      if (
        runs.length < expected &&
        now - Date.parse(row.created_at) < 10 * 60 * 1000
      ) {
        await status(
          row,
          "pending",
          `${CLEANUP_PREFIX}Waiting to reconcile preview dispatch before cleanup`,
        );
        continue;
      }
      const targets = machines.filter(
        (m) => sharedMachine(m) && m.handle === `pr-${row.payload.pr}`,
      );
      if (
        !row.payload.owner ||
        targets.some((m) => m.clerkUserId !== row.payload.owner)
      )
        throw new Error("Preview owner changed; cleanup held");
      if (targets.length > 1)
        throw new Error("Duplicate runtime targets; cleanup held");
      for (const target of targets) await platform.remove(target);
      // Includes tombstones and ambiguous/duplicate creates that disappeared
      // from fleet before this controller observed them.
      if (
        !(await platform.deletionConfirmed(row.payload.pr, row.payload.owner))
      ) {
        await status(
          row,
          "in_progress",
          `${CLEANUP_PREFIX}Waiting for physical preview cleanup confirmation`,
        );
        continue;
      }
      const fresh = await platform.fleet();
      if (pr.state === "closed") await platform.removePrivate(pr.number);
      machines = fresh;
      await status(row, "inactive", "Preview stopped; reservation released");
      await upsertComment(
        github,
        repo,
        pr.number,
        renderReview({
          pr,
          head: pr.head.sha,
          status: "Stopped",
          expiresAt: row.payload.expiresAt,
          web: null,
        }),
      );
    } catch (error) {
      console.error(
        "Preview cleanup requires reconciliation",
        error instanceof Error ? error.name : "UnknownError",
      );
      await status(
        row,
        "error",
        `${CLEANUP_PREFIX}Cleanup unavailable; capacity remains reserved`,
      );
    }
  }
  leases = leases.filter((r) => r.state !== "inactive");
  let plan = planQueue({
    requests: prs,
    reservations: leases,
    machines,
    pendingPrs,
    owner,
    now,
  });
  for (const pr of legacyDispatchDraining || !history.complete
    ? []
    : plan.admit) {
    // A fresh read before reservation closes head/label changes during inventory.
    const { data: live } = await github.rest.pulls.get({
      ...repo,
      pull_number: pr.number,
      request,
    });
    if (!eligible(live) || live.head.sha !== pr.head.sha) continue;
    const files = await pages(github.rest.pulls.listFiles, {
      ...repo,
      pull_number: pr.number,
    });
    const desktop =
      live.base?.ref !== "main" ||
      needsDesktop(
        files.flatMap((f) => [
          f.filename,
          ...(f.previous_filename ? [f.previous_filename] : []),
        ]),
      );
    const payload = {
      owner,
      schema: TASK,
      pr: pr.number,
      head: pr.head.sha,
      controllerSha,
      desktop,
      platform: files.some((f) =>
        [f.filename, f.previous_filename].some((path) =>
          path?.startsWith("packages/platform/"),
        ),
      ),
      expiresAt: new Date(
        Math.min(
          now + TTL_MS,
          ...machines
            .filter((m) => sharedMachine(m) && m.handle === `pr-${pr.number}`)
            .map((m) => Date.parse(m.provisionedAt) + TTL_MS),
        ),
      ).toISOString(),
    };
    const { data: row } = await github.rest.repos.createDeployment({
      ...repo,
      ref: pr.head.sha,
      task: TASK,
      environment: `review-pr-${pr.number}`,
      auto_merge: false,
      required_contexts: [],
      transient_environment: true,
      production_environment: false,
      payload,
      description: "Exploratory PR preview; all merge checks remain required",
      request,
    });
    if (!ownedLease(row))
      throw new Error("Preview reservation creation could not be reconciled");
    await status(row, "pending", "Dispatching exact-head preview builds");
    leases.push(row);
    // Reserve before dispatch. Unknown outcomes are retained and never blindly
    // retried; matching immutable run markers establish what actually happened.
    try {
      await github.rest.actions.createWorkflowDispatch({
        ...repo,
        workflow_id: "preview-vps.yml",
        ref: executionRef,
        inputs: {
          pr: String(pr.number),
          expected_head: pr.head.sha,
          preview_lease: String(row.id),
        },
        request,
      });
      if (desktop)
        await github.rest.actions.createWorkflowDispatch({
          ...repo,
          workflow_id: "preview-desktop.yml",
          ref: executionRef,
          inputs: {
            pr: String(pr.number),
            head: pr.head.sha,
            lease: String(row.id),
          },
          request,
        });
    } catch (error) {
      console.error(
        "Preview dispatch outcome requires reconciliation",
        error instanceof Error ? error.name : "UnknownError",
      );
      await status(
        row,
        "error",
        "Dispatch outcome uncertain; capacity held for reconciliation",
      );
    }
  }
  plan = planQueue({
    requests: prs,
    reservations: leases,
    machines,
    pendingPrs,
    owner,
    now,
  });
  const waiting = prs
    .filter(
      (p) => eligible(p) && !leases.some((r) => r.payload.pr === p.number),
    )
    .sort(
      (a, b) =>
        String(a.created_at).localeCompare(String(b.created_at)) ||
        a.number - b.number,
    );
  const active = machines.filter(sharedMachine).map((m) => {
    const n = Number(m.handle.slice(3));
    return {
      pr: n,
      author: prs.find((p) => p.number === n)?.user?.login ?? "legacy preview",
    };
  });
  for (const row of leases)
    if (!active.some((x) => x.pr === row.payload.pr))
      active.push({
        pr: row.payload.pr,
        author: prs.find((p) => p.number === row.payload.pr)?.user?.login,
      });
  await publishReviewComments({
    github,
    repo,
    prs,
    leases,
    machines,
    retiring,
    waiting,
    active,
    ownedRuns,
    status,
    now,
    occupied: plan.occupied,
    requestedPr,
    admissionHold: !history.complete
      ? "Reservation history recovering; queue admission paused"
      : legacyDispatchDraining
        ? "Legacy preview jobs draining; queue admission paused"
        : null,
  });
  return {
    capacity: CAPACITY,
    occupied: plan.occupied,
    waiting: waiting.length,
  };
}
