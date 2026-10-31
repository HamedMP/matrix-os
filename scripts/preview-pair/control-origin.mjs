const SHA = /^[a-f0-9]{40}$/;
const PATH = '.github/workflows/preview-collaboration-pair.yml';
const REPO = 'hamedmp/matrix-os';
const positive = value => Number.isSafeInteger(value) && value > 0;
const requireProof = value => { if (!value) throw new Error('Preview controller is unavailable'); };
const sameRepo = value => typeof value === 'string' && value.toLowerCase() === REPO;

/** Runs from a reviewed checkout before dependency installation or credentials.
 * Never attach these auxiliary jobs to a Main commit, even through a tag. The
 * protected execution branch/pin is reviewed setup, not candidate input. */
export async function verifyPreviewPairControlOrigin(github, context, pin) {
  requireProof(SHA.test(pin ?? '') && sameRepo(`${context?.repo?.owner}/${context?.repo?.repo}`));
  const branchName = `preview-pair-controller/${pin}`, ref = `refs/heads/${branchName}`;
  requireProof(context.eventName === 'workflow_dispatch' && context.sha === pin && context.workflowSha === pin
    && context.ref === ref && context.workflowRef?.toLowerCase() === `HamedMP/matrix-os/${PATH}@${ref}`.toLowerCase()
    && positive(context.runId) && positive(context.runAttempt));
  const repo = context.repo, request = { timeout: 10000 };
  const [main, branch, run] = await Promise.all([
    github.rest.repos.getBranch({ ...repo, branch: 'main', request }).then(result => result.data),
    github.rest.repos.getBranch({ ...repo, branch: branchName, request }).then(result => result.data),
    github.rest.actions.getWorkflowRun({ ...repo, run_id: context.runId, request }).then(result => result.data),
  ]);
  requireProof(main?.name === 'main' && SHA.test(main.commit?.sha ?? '') && branch?.name === branchName && branch.commit?.sha === pin);
  requireProof(run?.id === context.runId && run.run_attempt === context.runAttempt && run.event === 'workflow_dispatch'
    && run.head_sha === pin && run.head_branch === branchName && run.path?.split('@')[0] === PATH
    && sameRepo(run.repository?.full_name) && sameRepo(run.head_repository?.full_name)
    && positive(run.actor?.id) && run.actor.id === run.triggering_actor?.id
    && ['queued', 'requested', 'pending', 'waiting', 'in_progress'].includes(run.status) && run.conclusion === null);
  const [comparison, commit] = await Promise.all([
    github.rest.repos.compareCommitsWithBasehead({ ...repo, basehead: `${pin}...${main.commit.sha}`, request }).then(result => result.data),
    github.rest.repos.getCommit({ ...repo, ref: pin, request }).then(result => result.data),
  ]);
  requireProof(['behind', 'diverged'].includes(comparison?.status) && SHA.test(comparison.merge_base_commit?.sha ?? '')
    && comparison.merge_base_commit.sha !== pin && commit?.sha === pin && SHA.test(commit.commit?.tree?.sha ?? ''));
  return { schemaVersion: 1, controllerSha: pin, executionSha: pin, executionRef: ref,
    workflowPath: PATH, treeSha: commit.commit.tree.sha, actorId: run.actor.id, runId: run.id, runAttempt: run.run_attempt };
}
