import { describe, expect, it, vi } from 'vitest';
import {
  GATE_APP_SLUG,
  MERGE_QUALIFICATION_CHECK,
  assertReusedFrom,
  mergeQualificationEvidence,
  recordMergeQualification,
  resolveReusablePrCoverage,
} from '../../scripts/ci/main-ci-reuse.mjs';

const repo = { owner: 'HamedMP', repo: 'matrix-os' };
const parent = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40), squash = 'd'.repeat(40), tree = 'e'.repeat(40);
const gateAppId = 5271502;
const qualification = { controllerSha: 'f'.repeat(40), imageDigest: `sha256:${'1'.repeat(64)}`, harnessDigest: '2'.repeat(64) };
const evidence = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1, kind: 'merge-qualification', prNumber: 7, headSha: head, baseSha: parent, sourceSha: merge,
  requestingRunId: 321, requestingRunAttempt: 1, coverage: 'linux', ...qualification, ...overrides,
});
const proofCheck = (overrides: Record<string, unknown> = {}, summary = evidence()) => ({
  id: 900, name: MERGE_QUALIFICATION_CHECK, head_sha: head, status: 'completed', conclusion: 'success',
  external_id: `merge-qualification-${merge}-321-1`, app: { id: gateAppId, slug: GATE_APP_SLUG, owner: { login: 'HamedMP' } },
  output: { title: 'Exact merge qualified for reuse', summary: JSON.stringify(summary) }, ...overrides,
});

function fixture() {
  const commits: Record<string, any> = {
    [squash]: { sha: squash, parents: [{ sha: parent }], commit: { tree: { sha: tree } } },
    [merge]: { sha: merge, parents: [{ sha: parent }, { sha: head }], commit: { tree: { sha: tree } } },
  };
  const pull = { number: 7, merged_at: '2026-10-14T00:00:00Z', merge_commit_sha: squash, base: { ref: 'main', repo: { full_name: 'HamedMP/matrix-os' } }, head: { sha: head, ref: 'feature', repo: { full_name: 'HamedMP/matrix-os' } } };
  const run = {
    id: 321, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'pull_request', head_sha: head, head_branch: 'feature',
    path: '.github/workflows/ci.yml', display_title: `CI coverage-v1 · ${merge}`, created_at: '2026-10-13T23:00:00Z',
    repository: { full_name: 'HamedMP/matrix-os' }, head_repository: { full_name: 'HamedMP/matrix-os' },
  };
  const parentQualification = { id: 700, name: 'CI Source Qualification', head_sha: parent, status: 'completed', conclusion: 'success', app: { id: gateAppId, slug: GATE_APP_SLUG }, output: { summary: JSON.stringify({ sourceKind: 'main', sourceSha: parent, headSha: parent }) } };
  const newer: any[] = [];
  const linux: any[] = [];
  const aggregate = { id: 44, name: 'CI Results', run_id: 321, run_attempt: 1, head_sha: head, status: 'completed', conclusion: 'success', check_run_url: 'https://api.github.com/repos/HamedMP/matrix-os/check-runs/88' };
  const aggregateCheck = { id: 88, name: 'CI Results', head_sha: head, status: 'completed', conclusion: 'success', app: { slug: 'github-actions' }, details_url: 'https://github.com/HamedMP/matrix-os/actions/runs/321/job/44' };
  const checks = [proofCheck()];
  const github = {
    rest: {
      repos: {
        getCommit: vi.fn(async ({ ref }: { ref: string }) => ({ data: commits[ref] })),
        listPullRequestsAssociatedWithCommit: vi.fn(async () => ({ data: [pull] })),
      },
      checks: {
        listForRef: vi.fn(async (args: any) => ({ data: args.check_name === 'CI Source Qualification' ? { total_count: 1, check_runs: [parentQualification] } : args.check_name === 'Dedicated CI Results' ? { total_count: linux.length, check_runs: linux } : { total_count: checks.length, check_runs: checks } })),
        get: vi.fn(async () => ({ data: aggregateCheck })),
        create: vi.fn(async (args: any) => ({ data: { id: 901, ...args, app: { id: gateAppId } } })),
      },
      actions: {
        getWorkflowRunAttempt: vi.fn(async () => ({ data: run })),
        getWorkflowRun: vi.fn(async () => ({ data: run })),
        listWorkflowRuns: vi.fn(async () => ({ data: { total_count: newer.length, workflow_runs: newer } })),
        listJobsForWorkflowRunAttempt: vi.fn(async () => ({ data: { total_count: 1, jobs: [aggregate] } })),
      },
    },
  };
  return { github, commits, pull, run, parentQualification, newer, linux, aggregate, aggregateCheck, checks };
}

const resolve = (f: ReturnType<typeof fixture>, options: Record<string, unknown> = {}) => resolveReusablePrCoverage(f.github, repo, squash, { qualification, ...options });

describe('resolving reusable PR coverage for a main push', () => {
  it('reuses the qualified PR run when the squash tree equals the tested merge tree', async () => {
    const f = fixture();
    expect(await resolve(f, { gateAppId })).toEqual({
      reused: true,
      reusedFrom: { prNumber: 7, headSha: head, mergeSha: merge, tree, requestingRunId: 321, requestingRunAttempt: 1, qualificationCheckId: 900, coverage: 'linux', ...qualification },
    });
    expect(f.github.rest.checks.listForRef).toHaveBeenCalledWith(expect.objectContaining({ ref: head, check_name: MERGE_QUALIFICATION_CHECK, filter: 'all' }));
  });

  it('never reuses a refresh or hosted-recovery dispatch, which runs main\'s ci.yml with a reduced plan', async () => {
    const f = fixture();
    Object.assign(f.run, { event: 'workflow_dispatch', head_sha: squash, head_branch: 'main', display_title: `CI refresh-v1 pr=7 head=${head} base=${parent} merge=${merge}` });
    f.aggregate.head_sha = squash;
    f.aggregateCheck.head_sha = squash;
    expect(await resolve(f, { gateAppId })).toEqual({ reused: false, reason: 'qualified PR run is not a genuine successful CI run' });
  });

  it('identifies the gate App by slug when its id is not available', async () => {
    const f = fixture();
    expect(await resolve(f)).toMatchObject({ reused: true });
    f.checks[0].app = { id: 1, slug: 'someone-else', owner: { login: 'HamedMP' } };
    expect(await resolve(f)).toMatchObject({ reused: false });
  });

  it.each([
    ['a merge commit on main', (f: any) => { f.commits[squash].parents.push({ sha: head }); }, 'main commit is not a single-parent squash'],
    ['no merged PR', (f: any) => { f.github.rest.repos.listPullRequestsAssociatedWithCommit.mockResolvedValue({ data: [] }); }, 'no single merged PR for the main commit'],
    ['a PR merged elsewhere', (f: any) => { f.pull.merge_commit_sha = parent; }, 'no single merged PR for the main commit'],
    ['a fork PR', (f: any) => { f.pull.head.repo.full_name = 'someone/fork'; }, 'no single merged PR for the main commit'],
    ['no proof', (f: any) => { f.checks.splice(0); }, 'no merge qualification matches the squash'],
    ['a proof from another App', (f: any) => { f.checks[0].app = { id: 1, slug: GATE_APP_SLUG, owner: { login: 'HamedMP' } }; }, 'no merge qualification matches the squash'],
    ['a failed proof', (f: any) => { f.checks[0].conclusion = 'failure'; }, 'no merge qualification matches the squash'],
    ['a proof for another PR', (f: any) => { f.checks[0] = proofCheck({}, evidence({ prNumber: 8 })); }, 'no merge qualification matches the squash'],
    ['a proof on another base', (f: any) => { f.checks[0] = proofCheck({}, evidence({ baseSha: '9'.repeat(40) })); }, 'no merge qualification matches the squash'],
    ['a different tested tree', (f: any) => { f.commits[merge].commit.tree.sha = '8'.repeat(40); }, 'no merge qualification matches the squash'],
    ['a tested merge with other parents', (f: any) => { f.commits[merge].parents = [{ sha: '9'.repeat(40) }, { sha: head }]; }, 'no merge qualification matches the squash'],
    ['a tested merge of another head', (f: any) => { f.commits[merge].parents = [{ sha: parent }, { sha: '9'.repeat(40) }]; }, 'no merge qualification matches the squash'],
    ['a malformed proof', (f: any) => { f.checks[0].output.summary = '{not json'; }, 'no merge qualification matches the squash'],
    ['a proof from another controller pin', (f: any) => { f.checks[0] = proofCheck({}, evidence({ controllerSha: '3'.repeat(40) })); }, 'no merge qualification matches the squash'],
    ['a proof from another runner image', (f: any) => { f.checks[0] = proofCheck({}, evidence({ imageDigest: `sha256:${'4'.repeat(64)}` })); }, 'no merge qualification matches the squash'],
    ['a proof from another harness', (f: any) => { f.checks[0] = proofCheck({}, evidence({ harnessDigest: '5'.repeat(64) })); }, 'no merge qualification matches the squash'],
    ['a parent the gate did not qualify', (f: any) => { f.parentQualification.conclusion = 'failure'; }, 'main parent is not gate-qualified'],
    ['a parent still waiting for qualification', (f: any) => { f.parentQualification.conclusion = 'neutral'; }, 'main parent is not gate-qualified'],
    ['a parent qualification from another App', (f: any) => { f.parentQualification.app = { id: 1, slug: 'other' }; }, 'main parent is not gate-qualified'],
    ['a parent qualification for another commit', (f: any) => { f.parentQualification.output.summary = JSON.stringify({ sourceKind: 'main', sourceSha: '6'.repeat(40) }); }, 'main parent is not gate-qualified'],
    ['a not-applicable parent qualification', (f: any) => { f.parentQualification.output.summary = JSON.stringify({ sourceKind: 'main', sourceSha: parent, notApplicable: true }); }, 'main parent is not gate-qualified'],
    ['a superseding PR run for the same merge', (f: any) => { f.newer.push({ ...f.run, id: 999, conclusion: 'failure' }); }, 'qualified PR run is not a genuine successful CI run'],
    ['a newer attempt of the same run before the merge', (f: any) => { f.github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { ...f.run, run_attempt: 2, run_started_at: '2026-10-13T23:30:00Z' } }); }, 'qualified PR run is not a genuine successful CI run'],
    ['a Linux failure on the main commit', (f: any) => { f.linux.push({ id: 60, name: 'Dedicated CI Results', head_sha: squash, status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' } }); }, 'Linux qualification failed on the main commit'],
    ['a failed requesting run', (f: any) => { f.run.conclusion = 'failure'; }, 'qualified PR run is not a genuine successful CI run'],
    ['a dispatched run that otherwise matches the PR run', (f: any) => { f.run.event = 'workflow_dispatch'; }, 'qualified PR run is not a genuine successful CI run'],
    ['a run for another merge', (f: any) => { f.run.display_title = `CI coverage-v1 · ${'7'.repeat(40)}`; }, 'qualified PR run is not a genuine successful CI run'],
    ['a run from another workflow', (f: any) => { f.run.path = '.github/workflows/other.yml'; }, 'qualified PR run is not a genuine successful CI run'],
    ['a failed aggregate', (f: any) => { f.aggregate.conclusion = 'failure'; }, 'qualified PR run is not a genuine successful CI run'],
    ['a forged aggregate check', (f: any) => { f.aggregateCheck.app = { slug: 'someone' }; }, 'qualified PR run is not a genuine successful CI run'],
  ])('refuses %s', async (_name, mutate, reason) => {
    const f = fixture();
    mutate(f);
    expect(await resolve(f, { gateAppId })).toEqual({ reused: false, reason });
  });

  it('ignores runs and re-runs that started after the PR merged', async () => {
    const f = fixture();
    f.newer.push({ ...f.run, id: 999, conclusion: 'failure', created_at: '2026-10-14T01:00:00Z' });
    f.github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { ...f.run, run_attempt: 2, run_started_at: '2026-10-14T01:00:00Z' } } as any);
    expect(await resolve(f, { gateAppId })).toMatchObject({ reused: true });
  });

  it('ignores newer runs for other merges of the same head', async () => {
    const f = fixture();
    f.newer.push({ ...f.run, id: 999, display_title: `CI coverage-v1 · ${'6'.repeat(40)}` });
    expect(await resolve(f, { gateAppId })).toMatchObject({ reused: true });
  });

  it('refuses a recorded frontier that is not the squash parent', async () => {
    const f = fixture();
    expect(await resolve(f, { gateAppId, frontier: { coverageBaseSha: parent, bootstrap: false } })).toMatchObject({ reused: true });
    expect(await resolve(f, { gateAppId, frontier: { coverageBaseSha: '6'.repeat(40), bootstrap: false } })).toEqual({ reused: false, reason: 'main coverage frontier is not the squash parent' });
    expect(await resolve(f, { gateAppId, frontier: { coverageBaseSha: parent, bootstrap: true } })).toEqual({ reused: false, reason: 'main coverage frontier is not the squash parent' });
  });

  it('re-verifies only the proof a receipt named', async () => {
    const f = fixture();
    expect(await resolve(f, { gateAppId, checkId: 900 })).toMatchObject({ reused: true });
    expect(await resolve(f, { gateAppId, checkId: 901 })).toEqual({ reused: false, reason: 'no merge qualification matches the squash' });
  });

  it('fails closed on incomplete histories and missing configuration', async () => {
    const f = fixture();
    const list = f.github.rest.checks.listForRef.getMockImplementation()!;
    f.github.rest.checks.listForRef.mockImplementation(async (args: any) => (args.check_name === MERGE_QUALIFICATION_CHECK ? { data: { total_count: 101, check_runs: f.checks } } : list(args)) as any);
    await expect(resolve(f, { gateAppId })).rejects.toThrow('inventory is incomplete');
    const g = fixture();
    g.github.rest.actions.listWorkflowRuns.mockResolvedValue({ data: { total_count: 101, workflow_runs: [] } } as any);
    await expect(resolve(g, { gateAppId })).rejects.toThrow('history is incomplete');
    await expect(resolveReusablePrCoverage(fixture().github, repo, squash, { gateAppId })).rejects.toThrow('qualification configuration');
  });

  it('picks the newest proof that matches when a head was qualified for several merges', async () => {
    const f = fixture();
    const older = proofCheck({ id: 800, external_id: `merge-qualification-${'6'.repeat(40)}-300-1` }, evidence({ sourceSha: '6'.repeat(40), requestingRunId: 300 }));
    f.checks.unshift(older);
    expect(await resolve(f, { gateAppId })).toMatchObject({ reused: true, reusedFrom: { qualificationCheckId: 900, mergeSha: merge } });
  });

  it('lets API failures surface instead of reporting no reuse', async () => {
    const f = fixture();
    f.github.rest.repos.getCommit.mockRejectedValue(new Error('rate limited'));
    await expect(resolve(f, { gateAppId })).rejects.toThrow('rate limited');
  });
});

describe('recording a merge qualification', () => {
  const snapshot = { prNumber: 7, headSha: head, baseSha: parent, sourceSha: merge };
  const requester = { id: 321, run_attempt: 1 };
  const record = (f: ReturnType<typeof fixture>, gateGithub = f.github) =>
    recordMergeQualification({ github: f.github, gateGithub, repo, snapshot, requester, coverage: 'linux', qualification, gateAppId });

  it('creates one immutable success check on the PR head bound to the merge and run', async () => {
    const f = fixture();
    f.checks.splice(0);
    await record(f);
    expect(f.github.rest.checks.create).toHaveBeenCalledWith(expect.objectContaining({
      name: MERGE_QUALIFICATION_CHECK, head_sha: head, status: 'completed', conclusion: 'success',
      external_id: `merge-qualification-${merge}-321-1`,
      output: expect.objectContaining({ summary: JSON.stringify(evidence()) }),
    }));
  });

  it('never writes the same proof twice', async () => {
    const f = fixture();
    await record(f);
    expect(f.github.rest.checks.create).not.toHaveBeenCalled();
  });

  it('refuses an issuer response from another App', async () => {
    const f = fixture();
    f.checks.splice(0);
    f.github.rest.checks.create.mockResolvedValue({ data: { id: 901, app: { id: 1 } } } as any);
    await expect(record(f)).rejects.toThrow('issuer');
  });

  it('builds evidence only from validated snapshot fields', () => {
    expect(mergeQualificationEvidence({ snapshot, requester, coverage: 'linux', qualification })).toEqual(evidence());
    expect(() => mergeQualificationEvidence({ snapshot: { ...snapshot, sourceSha: 'nope' }, requester, coverage: 'linux', qualification })).toThrow();
    expect(() => mergeQualificationEvidence({ snapshot, requester, coverage: 'guess', qualification })).toThrow();
    expect(() => mergeQualificationEvidence({ snapshot, requester, coverage: 'linux', qualification: { ...qualification, imageDigest: 'latest' } })).toThrow();
  });
});

describe('reusedFrom receipts', () => {
  const valid = { prNumber: 7, headSha: head, mergeSha: merge, tree, requestingRunId: 321, requestingRunAttempt: 1, qualificationCheckId: 900, coverage: 'linux', ...qualification };

  it('accepts exactly the resolved shape', () => {
    expect(() => assertReusedFrom(valid)).not.toThrow();
  });

  it.each([
    ['an extra key', { ...valid, extra: 1 }],
    ['a missing key', (({ tree: _tree, ...rest }) => rest)(valid)],
    ['a bad sha', { ...valid, mergeSha: 'x' }],
    ['a bad run id', { ...valid, requestingRunId: 0 }],
    ['an unknown coverage', { ...valid, coverage: 'guess' }],
    ['a hosted-recovery coverage', { ...valid, coverage: 'hosted-recovery' }],
    ['a bad image digest', { ...valid, imageDigest: 'latest' }],
  ])('rejects %s', (_name, value) => {
    expect(() => assertReusedFrom(value)).toThrow('Invalid reused PR coverage');
  });
});
