import { pages, request, publishReviewComment } from "./preview-review-api.mjs";
import { renderReview } from "./preview-review-model.mjs";

// Rotate over at most 1,200 recently updated closed PRs. Events provide immediate
// recovery for the requested PR; periodic passes repair missed close events.
export async function collectReviewPrs({
  github, repo, open, leases, requestedPr, now,
}) {
  const prs = [...open];
  const { data: closed } = await github.rest.pulls.list({
    ...repo,
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: 24,
    page: 1 + Math.floor(now / 300000) % 50,
    request,
  });
  if (!Array.isArray(closed) || closed.length > 24)
    throw new Error("Preview recovery inventory unavailable");
  for (const pr of closed)
    if (!prs.some((p) => p.number === pr.number)) prs.push(pr);
  const required = [...leases.map((r) => r.payload.pr)];
  if (Number.isSafeInteger(requestedPr) && requestedPr > 0)
    required.push(requestedPr);
  for (const number of required) {
    if (prs.some((p) => p.number === number)) continue;
    const { data } = await github.rest.pulls.get({
      ...repo, pull_number: number, request,
    });
    prs.push(data);
  }
  return prs;
}

export async function stopExistingReview({
  github, repo, pr, snapshot, waiting, active, occupied,
}) {
  // Recovery must never create comments on unrelated, unlabelled PRs. The
  // GraphQL tail may omit an older queue comment; use bounded REST recovery.
  if (!snapshot.old && snapshot.previous) {
    const rows = await pages(github.rest.issues.listComments, {
      ...repo, issue_number: pr.number,
    });
    const old = rows.find((c) =>
      c.user?.login === "github-actions[bot]" &&
      c.body?.startsWith("<!-- matrix-preview-review-v1 -->"),
    );
    if (old)
      snapshot = { ...snapshot, old: { databaseId: old.id, body: old.body } };
  }
  if (!snapshot.old || snapshot.old.body.includes("**PR preview: Stopped**"))
    return;
  await publishReviewComment(
    github, repo, pr.number,
    renderReview({
      pr, head: snapshot.head, status: "Stopped", web: null,
      queue: waiting, active, occupied,
    }),
    snapshot,
  );
}
