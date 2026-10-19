import { deploymentStates, request } from "./preview-review-api.mjs";
import { ownedLease, TASK } from "./preview-review-model.mjs";
const RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PAGES = 50;
const MAX_PRUNE = 100;

/** Keep active leases authoritative while incrementally removing old tombstones. */
export async function loadPreviewHistory({ github, repo, now = Date.now() }) {
  const leases = [],
    prune = [];
  let complete = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data: rows } = await github.rest.repos.listDeployments({
      ...repo,
      task: TASK,
      per_page: 100,
      page,
      request,
    });
    if (!Array.isArray(rows) || rows.length > 100)
      throw new Error("Preview reservation inventory unavailable");
    const owned = rows.filter(
      (row) =>
        row.task === TASK && row.creator?.login === "github-actions[bot]",
    );
    if (owned.some((row) => !ownedLease(row)))
      throw new Error("Invalid owned preview reservation");
    const states = await deploymentStates(github, repo, owned);
    for (const row of states) {
      if (row.state !== "inactive") leases.push(row);
      else if (
        prune.length < MAX_PRUNE &&
        Date.parse(row.created_at) < now - RETAIN_MS
      )
        prune.push(row.id);
    }
    if (rows.length < 100) {
      complete = true;
      break;
    }
  }
  // Do not delete during offset pagination: removing page-one rows would shift
  // later active leases out of the inventory and incorrectly free capacity.
  for (const id of prune) {
    try {
      await github.rest.repos.deleteDeployment({
        ...repo,
        deployment_id: id,
        request,
      });
    } catch (error) {
      console.error(
        "Preview history pruning incomplete",
        error instanceof Error ? error.name : "UnknownError",
      );
      complete = false;
      break;
    }
  }
  return { leases, complete };
}
