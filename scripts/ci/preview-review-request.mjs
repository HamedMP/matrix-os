import {
  cleanupStarted,
  SHA,
  TASK,
  ownedLease,
  eligible,
  repoName,
} from "./preview-review-model.mjs";
const request = { timeout: 10000 };
export async function verifyPreviewRequest(github, repo, input) {
  const pr = Number(input.pr),
    lease = Number(input.lease),
    head = input.head;
  if (
    repoName(repo) !== "hamedmp/matrix-os" ||
    !/^[1-9][0-9]{0,8}$/.test(String(input.pr)) ||
    !/^[1-9][0-9]{0,15}$/.test(String(input.lease)) ||
    !Number.isSafeInteger(lease) ||
    !SHA.test(head ?? "") ||
    !SHA.test(input.controllerSha ?? "")
  )
    throw new Error("Invalid preview request");
  const { data: row } = await github.rest.repos.getDeployment({
    ...repo,
    deployment_id: lease,
    request,
  });
  if (
    !ownedLease(row) ||
    row.id !== lease ||
    row.payload.pr !== pr ||
    row.payload.head !== head ||
    row.payload.controllerSha !== input.controllerSha ||
    Date.parse(row.payload.expiresAt) <= (input.now ?? Date.now())
  )
    throw new Error("Preview reservation unavailable");
  const { data: states } = await github.rest.repos.listDeploymentStatuses({
    ...repo,
    deployment_id: lease,
    per_page: 1,
    request,
  });
  if (
    cleanupStarted(states[0] ?? {}) ||
    !["pending", "in_progress", "success"].includes(states[0]?.state)
  )
    throw new Error("Preview reservation is not active");
  const { data: live } = await github.rest.pulls.get({
    ...repo,
    pull_number: pr,
    request,
  });
  if (!eligible(live) || live.head.sha !== head)
    throw new Error("Preview source changed or closed");
  return { pr, head, lease };
}
export { TASK };
