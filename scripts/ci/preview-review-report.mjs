import { stopExistingReview } from "./preview-review-recovery.mjs";
import {
  eligible,
  labeled,
  renderReview,
  sharedMachine,
} from "./preview-review-model.mjs";
import {
  pages,
  request,
  reviewPublication,
  publishReviewComment,
} from "./preview-review-api.mjs";
const terminal = (run) => run?.status === "completed";
const url = (run) =>
  `https://github.com/HamedMP/matrix-os/actions/runs/${run.id}`;
export async function publishReviewComments({
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
  occupied,
  admissionHold,
  requestedPr,
}) {
  // Active reviews refresh every pass. Rotate waiting comments so a large
  // backlog cannot exhaust the repository's hourly Actions API allowance.
  const candidates = prs,
    urgent = candidates.filter(
      (p) =>
        leases.some((r) => r.payload.pr === p.number) ||
        p.number === requestedPr,
    );
  const queued = candidates.filter((p) => !urgent.includes(p));
  const budget = Math.max(0, 24 - urgent.length),
    offset = queued.length
      ? (Math.floor(now / 300000) * Math.max(1, budget)) % queued.length
      : 0;
  const selected = [
    ...urgent,
    ...Array.from(
      { length: Math.min(budget, queued.length) },
      (_, i) => queued[(offset + i) % queued.length],
    ),
  ];
  for (const pr of selected) {
    const row = leases.find((r) => r.payload.pr === pr.number);
    if (row && retiring.some((r) => r.id === row.id)) continue;
    if (!row && (!labeled(pr) || pr.state !== "open")) {
      const snapshot = await reviewPublication(github, repo, pr.number);
      if (snapshot.head === pr.head.sha && (!snapshot.labeled || !snapshot.open))
        await stopExistingReview({
          github, repo, pr, snapshot, waiting, active, occupied,
        });
      continue;
    }
    let label = eligible(pr)
        ? "Queued"
        : pr.labels?.some((l) => l.name === "preview-collaboration")
          ? "Protected collaboration preview: use the existing reviewed workflow"
          : "Unavailable: same-repository open PR required",
      web = null,
      artifacts = [],
      runs = [];
    if (row) {
      label =
        row.payload.head === pr.head.sha
          ? "Builds starting"
          : "Stopping previous head; latest head queued";
      if (
        row.payload.head === pr.head.sha &&
        !retiring.some((r) => r.id === row.id)
      ) {
        const jobs = await ownedRuns(row);
        runs = jobs.map(({ kind, run }) => ({
          label:
            kind === "web"
              ? "Web build and stability checks"
              : "Desktop packaging (Windows unsigned preview)",
          url: url(run),
          state: terminal(run) ? run.conclusion : run.status,
        }));
        const webRun = jobs.find((x) => x.kind === "web")?.run;
        const desktopRun = jobs.find((x) => x.kind === "desktop")?.run;
        const version = webRun
          ? new RegExp(
              `^v[0-9]{4}\\.[0-9]{2}\\.[0-9]{2}-pr${pr.number}-${webRun.id}-${webRun.run_attempt}-${pr.head.sha.slice(0, 7)}$`,
            )
          : null;
        const installed =
          version &&
          machines.some(
            (m) =>
              sharedMachine(m) &&
              m.clerkUserId === row.payload.owner &&
              m.handle === `pr-${pr.number}` &&
              m.healthy === true &&
              version.test(m.runtimeVersion ?? ""),
          );
        const ambiguous =
          jobs.filter((j) => j.kind === "web").length > 1 ||
          jobs.filter((j) => j.kind === "desktop").length > 1;
        if (installed && !ambiguous)
          web = `https://app.matrix-os.com/vm/pr-${pr.number}`;
        if (
          !ambiguous &&
          desktopRun?.conclusion === "success" &&
          terminal(desktopRun)
        ) {
          const rows = await pages(
            github.rest.actions.listWorkflowRunArtifacts,
            { ...repo, run_id: desktopRun.id },
            "artifacts",
          );
          const prefix = `preview-desktop-pr${pr.number}-${pr.head.sha}-lease${row.id}`;
          const available = rows.filter(
            (a) => !a.expired && Date.parse(a.expires_at) > now,
          );
          if (available.some((a) => a.name === `${prefix}-source`)) {
            for (const [suffix, name] of [
              ["macos-arm64", "macOS Apple Silicon"],
              ["macos-x64", "macOS Intel"],
              ["linux-x64", "Linux x64"],
              ["windows-x64", "Windows x64 · unsigned preview"],
            ]) {
              const artifact = available.find(
                (a) => a.name === `${prefix}-${suffix}`,
              );
              if (artifact)
                artifacts.push({
                  label: name,
                  url: `${url(desktopRun)}/artifacts/${artifact.id}`,
                  expiresAt: artifact.expires_at,
                });
            }
          }
        }
        const failed = jobs.some(
          ({ run }) => terminal(run) && run.conclusion !== "success",
        );
        label = ambiguous
          ? "Conflicting preview runs; close or remove label to reconcile"
          : failed
            ? "Failed; slot held until retry, close or expiry"
            : row.payload.desktop &&
                desktopRun?.conclusion === "success" &&
                terminal(desktopRun) &&
                artifacts.length !== 4
              ? "Desktop downloads unavailable/expired; remove and re-add preview to rebuild"
              : webRun?.conclusion === "success" &&
                  installed &&
                  (!row.payload.desktop || artifacts.length === 4)
                ? "Ready for review"
                : web
                  ? "Web available; validation in progress"
                  : "Build/deploy in progress";
        if (
          row.state === "error" &&
          jobs.length < (row.payload.desktop ? 2 : 1)
        )
          label = "Dispatch uncertain; operator reconciliation required";
        await status(
          row,
          label === "Ready for review"
            ? "success"
            : failed
              ? "failure"
              : row.state === "error"
                ? "error"
                : "in_progress",
          label,
        );
      }
    }
    if (!row && eligible(pr) && admissionHold) label = admissionHold;
    // Re-read before publishing: never publish a stale SHA with fresh-looking links.
    const snapshot = await reviewPublication(github, repo, pr.number);
    if (snapshot.head !== pr.head.sha || !snapshot.labeled || !snapshot.open)
      continue;
    await publishReviewComment(
      github,
      repo,
      pr.number,
      renderReview({
        pr,
        head: snapshot.head,
        status: label,
        expiresAt: row?.payload.expiresAt,
        web,
        artifacts,
        queue: waiting,
        active,
        runs,
        platform: row?.payload.platform,
        desktop: row?.payload.head === snapshot.head ? row.payload.desktop : undefined,
        occupied,
      }),
      snapshot,
    );
  }
}
