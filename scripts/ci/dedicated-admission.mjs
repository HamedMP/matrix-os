// Data-only decisions. The privileged controller loads this file only from its
// authenticated default-branch SHA; never load it from a PR or parent checkout.
import {admitRefreshController} from './dedicated-refresh.mjs';
const shaPattern = /^[a-f0-9]{40}$/;
const request = {timeout: 10_000};
const sameRepo = (value, repo) => typeof value === 'string' && value.toLowerCase() === repo.toLowerCase();
const branchRef = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\x00-\x1f\x7f]/.test(value);
const repository = repo => `${repo.owner}/${repo.repo}`;
const admittedPull = (pull, fullName) => pull?.state === 'open' && pull.draft === false &&
  sameRepo(pull.head?.repo?.full_name, fullName) && sameRepo(pull.base?.repo?.full_name, fullName) &&
  ['ready-for-ci','ci-linux'].every(name => pull.labels?.some(label => label.name === name));
const validSnapshot = value => Number.isSafeInteger(value?.prNumber) && value.prNumber > 0 &&
  [value.headSha, value.baseSha, value.sourceSha].every(sha => shaPattern.test(sha || '')) && branchRef(value.baseRef);

export async function liveParentRefSha(github,repo,baseRef) {
  if(!branchRef(baseRef))throw new Error('Invalid live parent ref');
  const {data}=await github.rest.git.getRef({...repo,ref:`heads/${baseRef}`,request});
  if(!shaPattern.test(data?.object?.sha||''))throw new Error('Invalid live parent ref response');
  return data.object.sha;
}

export function selectDedicatedRoute({repository: fullName, eventName, enabled, shouldRun, pull}) {
  return enabled === 'true' && shouldRun === 'true' && eventName === 'pull_request' &&
    typeof fullName === 'string' && admittedPull(pull, fullName) === true && branchRef(pull.base.ref);
}

export function assertDefaultController(repo, controller) {
  const expected = `${repository(repo)}/.github/workflows/ci-dedicated.yml@refs/heads/main`;
  if (controller?.ref !== 'refs/heads/main' || !shaPattern.test(controller.sha || '') ||
      controller.workflowRef?.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('Dedicated controller must originate from the reviewed default branch');
  }
}

function eventRequested(payload) {
  if (payload.action === 'edited') return Boolean(payload.changes?.base);
  return ['opened', 'reopened', 'labeled', 'ready_for_review', 'synchronize'].includes(payload.action);
}

export async function admitDedicatedSource(github, input) {
  const {repo, controller, eventName, payload, inputSha} = input;
  assertDefaultController(repo, controller);
  if(eventName==='workflow_run')return admitRefreshController(github,repo,payload);
  if (eventName === 'workflow_dispatch') {
    const sourceSha = inputSha || controller.sha;
    if (!shaPattern.test(sourceSha)) throw new Error('Exact commit SHA required');
    const {data: commit} = await github.rest.repos.getCommit({...repo, ref: sourceSha, request});
    if (commit.sha !== sourceSha) throw new Error('Exact commit unavailable');
    return {sourceSha, headSha: sourceSha, baseSha: '', baseRef: '', prNumber: 0};
  }
  if (eventName !== 'pull_request_target') throw new Error('Unsupported controller event');
  if (!eventRequested(payload)) return null;
  const eventPull = payload.pull_request;
  if (!Number.isSafeInteger(eventPull?.number) || eventPull.number < 1 ||
      ![eventPull.head?.sha, eventPull.base?.sha].every(sha => shaPattern.test(sha || '')) ||
      !branchRef(eventPull.base?.ref)) throw new Error('Invalid PR revision snapshot');
  const {data: pull} = await github.rest.pulls.get({...repo, pull_number: eventPull.number, request});
  if (pull.number !== eventPull.number || !admittedPull(pull, repository(repo)) ||
      pull.head.sha !== eventPull.head.sha || pull.base.sha !== eventPull.base.sha ||
      pull.base.ref !== eventPull.base.ref) return null;
  if(await liveParentRefSha(github,repo,pull.base.ref)!==pull.base.sha)throw new Error('Current parent ref has changed');
  const snapshot = {sourceSha: pull.merge_commit_sha, headSha: pull.head.sha,
    baseSha: pull.base.sha, baseRef: pull.base.ref, prNumber: pull.number};
  if (!validSnapshot(snapshot)) throw new Error('Current merge commit unavailable');
  const {data: merge} = await github.rest.repos.getCommit({...repo, ref: snapshot.sourceSha, request});
  const parents = merge.parents?.map(parent => parent.sha) || [];
  if (merge.sha !== snapshot.sourceSha || parents.length !== 2 ||
      parents[0]!==snapshot.baseSha || parents[1]!==snapshot.headSha) {
    throw new Error('Merge commit does not bind the current PR head and base');
  }
  return snapshot;
}

// Revalidate before dispatch, settlement and waiter acceptance. A parent move
// without a child commit requires a fresh main-defined requesting run; an old
// Actions rerun retains its event snapshot and cannot certify the new candidate.
export async function verifyCurrentDedicatedSource(github, repo, snapshot) {
  if (snapshot?.prNumber === 0) return;
  if (!validSnapshot(snapshot)) throw new Error('Invalid dedicated qualification revision');
  const {data: pull} = await github.rest.pulls.get({...repo, pull_number: snapshot.prNumber, request});
  if (pull.number !== snapshot.prNumber || !admittedPull(pull, repository(repo)) ||
      pull.head.sha !== snapshot.headSha || (snapshot.headRef !== undefined && pull.head.ref !== snapshot.headRef) ||
      pull.base.sha !== snapshot.baseSha ||
      pull.base.ref !== snapshot.baseRef || pull.merge_commit_sha !== snapshot.sourceSha) {
    throw new Error('Dedicated qualification revision or admission is stale');
  }
  if(await liveParentRefSha(github,repo,snapshot.baseRef)!==snapshot.baseSha)throw new Error('Current parent ref has changed');
  return pull;
}

export {reconcileDedicatedChildren} from './dedicated-reconcile.mjs';
export {verifyDedicatedLeaseGrant,newestRequestingCiRun} from './dedicated-lease.mjs';
export {runDedicatedLeaseSession,dispatchDedicatedLease,validateLeaseRequest,canonicalRequest,verifyLeaseReceipt} from './dedicated-ssh.mjs';

export {reconcileSourceQualification} from './dedicated-source-gate.mjs';
