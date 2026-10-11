// Read-only GitHub API evidence verification. Never execute controller artifacts.
const workflowPath = '.github/workflows/ci-dedicated.yml';
const trustedRunPath = value => [workflowPath, `${workflowPath}@main`, `${workflowPath}@refs/heads/main`].includes(value);
const shaPattern = /^[a-f0-9]{40}$/;
const request = { timeout: 10_000 };
const sameRepo = (value, expected) => typeof value === 'string' && value.toLowerCase() === `${expected.owner}/${expected.repo}`.toLowerCase();

function parseEvidence(check, expected) {
  if (check.name !== 'Dedicated CI Results' || check.head_sha !== expected.headSha ||
      check.app?.slug !== 'github-actions' || check.status !== 'completed') return null;
  const prefix = `${expected.serverUrl}/${expected.owner}/${expected.repo}/actions/runs/`;
  if (typeof check.details_url !== 'string' || !check.details_url.startsWith(prefix)) return null;
  const id = check.details_url.slice(prefix.length);
  if (!/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) return null;
  const summary = check.output?.summary;
  if (typeof summary !== 'string' || summary.length > 4096) return null;
  let evidence;
  try { evidence = JSON.parse(summary); }
  catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  if (!evidence || evidence.schemaVersion !== 1 || evidence.suite !== 'qualification' ||
      evidence.sourceSha !== expected.sourceSha || evidence.headSha !== expected.headSha ||
      evidence.baseSha !== expected.baseSha || evidence.prNumber !== expected.prNumber ||
      !shaPattern.test(evidence.controllerSha || '') || evidence.controllerRef !== 'refs/heads/main' ||
      evidence.controllerWorkflow !== workflowPath) return null;
  return { ...evidence, runId: Number(id) };
}

export async function waitForDedicatedResult(github, expected, options = {}) {
  if (![expected.headSha, expected.baseSha, expected.sourceSha].every(sha => shaPattern.test(sha || '')) ||
      !Number.isSafeInteger(expected.prNumber) || expected.prNumber < 1) throw new Error('Invalid dedicated qualification revision');
  const maxAttempts = options.maxAttempts ?? 130;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 130) throw new Error('Invalid wait bound');
  const delay = options.delay ?? (() => new Promise(resolve => setTimeout(resolve, 30_000)));
  const repo = {owner: expected.owner, repo: expected.repo};
  const {data: workflow} = await github.rest.actions.getWorkflow({...repo, workflow_id: 'ci-dedicated.yml', request});
  if (workflow.path !== workflowPath) throw new Error('Unexpected dedicated controller workflow');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Bounded pagination: a malicious producer cannot make this waiter allocate
    // indefinitely. Unknown, malformed, partial or stale checks never pass.
    for (let page = 1; page <= 3; page++) {
      const {data} = await github.rest.checks.listForRef({...repo, ref: expected.headSha, per_page: 100, page, filter: 'all', request});
      const checks = data.check_runs ?? [];
      for (const check of checks) {
        const evidence = parseEvidence(check, expected);
        if (!evidence) continue;
        const {data: run} = await github.rest.actions.getWorkflowRun({...repo, run_id: evidence.runId, request});
        if (run.workflow_id !== workflow.id || !trustedRunPath(run.path) || run.event !== 'pull_request_target' ||
            run.head_sha !== evidence.controllerSha || !sameRepo(run.repository?.full_name, expected) ||
            !sameRepo(run.head_repository?.full_name, expected) || run.status !== 'completed') continue;
        // Immutable artifacts can only be uploaded into their own workflow run.
        // The trusted controller names this artifact from its admitted tuple;
        // another workflow cannot forge this binding by copying a check URL.
        const artifactName=`dedicated-qualification-${expected.headSha}-${expected.sourceSha}-${expected.baseSha}-pr${expected.prNumber}`;
        const {data: artifactData}=await github.rest.actions.listWorkflowRunArtifacts({...repo,run_id:evidence.runId,per_page:100,request});
        const provenance=artifactData.artifacts?.find(artifact=>artifact.name===artifactName);
        if(!provenance || provenance.expired || provenance.workflow_run?.id!==evidence.runId ||
            !Number.isSafeInteger(provenance.size_in_bytes) || provenance.size_in_bytes<1 || provenance.size_in_bytes>16384)continue;
        const {data: jobData} = await github.rest.actions.listJobsForWorkflowRun({...repo, run_id: evidence.runId, per_page: 100, filter: 'latest', request});
        const dispatch = jobData.jobs?.find(job => job.name === 'benchmark');
        if (!dispatch || dispatch.status !== 'completed') continue;
        if (check.conclusion !== 'success' || run.conclusion !== 'success' || dispatch.conclusion !== 'success') {
          throw new Error('Verified dedicated Linux qualification failed');
        }
        return {runId: evidence.runId, sourceSha: expected.sourceSha};
      }
      if (checks.length < 100) break;
    }
    if (attempt + 1 < maxAttempts) await delay();
  }
  throw new Error('No verified dedicated Linux qualification completed within the bounded wait');
}
