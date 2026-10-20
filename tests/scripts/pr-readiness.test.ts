import { describe, expect, it } from 'vitest';
import { assessReadiness, collectReadiness } from '../../scripts/review/pr-readiness.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const snapshot = () => ({
  number: 2798, state: 'OPEN', isDraft: false, headRefOid: head, baseRefOid: base,
  baseRefName: 'main', author: { login: 'owner' }, reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE', body: 'ENG-240', url: 'https://github.com/HamedMP/matrix-os/pull/2798',
});
const evidence = () => ({
  pull: snapshot(), review: { head, ok: true, score: '5/5', reason: 'current' },
  threads: [], reviews: [{ author: { login: 'peer', __typename: 'User' },
    state: 'APPROVED', commit: { oid: head } }],
  checks: [{ name: 'CI Results', state: 'SUCCESS', bucket: 'pass', link: 'https://github.com/example' }],
});

describe('shared advisory readiness', () => {
  it('never converts green status badges into qualification or merge permission', () => {
    const report = assessReadiness(evidence());
    expect(report.decision).toBe('verify-evidence');
    expect(report.qualificationVerified).toBe(false);
    expect(report.nextActions.join(' ')).toMatch(/qualification/);
    expect(report.manualGates).toContain('finding dispositions and applicable live surface evidence');
  });

  it('keeps draft, review and CI admission separate', () => {
    const input = evidence();
    input.pull.isDraft = true;
    input.checks = [{ name: 'CI Results', state: 'SKIPPED', bucket: 'skipping', link: '' }];
    const report = assessReadiness(input);
    expect(report.blockers).toContain('PR is draft');
    expect(report.blockers).toContain('required checks have not all passed');
    expect(report.qualificationVerified).toBe(false);
  });

  it('blocks stale review, unresolved threads, conflicts and missing ticket references', () => {
    const input = evidence();
    input.review.ok = false;
    input.pull.mergeable = 'CONFLICTING';
    input.pull.body = '';
    input.threads = [{ id: 'unresolved', isResolved: false }] as never[];
    expect(assessReadiness(input).blockers).toEqual(expect.arrayContaining([
      'Greptile review is not valid for this head', '1 unresolved review thread(s)',
      'mergeability is CONFLICTING', 'missing ENG ticket reference',
    ]));
  });

  it.each(['stale', 'self', 'bot', 'changes-requested'])('rejects %s approval despite live APPROVED rollup', kind => {
    const input = evidence();
    if (kind === 'stale') input.reviews[0].commit.oid = base;
    if (kind === 'self') input.reviews[0].author.login = 'owner';
    if (kind === 'bot') input.reviews[0].author.__typename = 'Bot';
    if (kind === 'changes-requested') input.reviews.push({ ...input.reviews[0], state: 'CHANGES_REQUESTED' });
    expect(assessReadiness(input).blockers).toContain('no current-head independent human approval');
  });

  it('does not accept missing CI checks or stale carry-over output', () => {
    const input = evidence();
    input.checks = [];
    input.review.head = base;
    expect(assessReadiness(input).blockers).toEqual(expect.arrayContaining([
      'required checks are unavailable or empty', 'Greptile review is not valid for this head',
    ]));
  });
});

function collectorFixture(options: { race?: 'base' | 'head'; pages?: number; failure?: boolean; checks?: 'absent' | 'denied' } = {}) {
  const calls: { command: string; args: string[] }[] = [];
  let views = 0;
  let page = 0;
  const run = (command: string, args: string[]) => {
    calls.push({ command, args });
    if (options.failure) throw new Error('GitHub unavailable');
    if (command === process.execPath) return { status: 0, stdout: JSON.stringify(evidence().review) };
    if (args[0] === 'pr' && args[1] === 'view') {
      const pull = snapshot();
      if (views++ > 0 && options.race) pull[options.race === 'head' ? 'headRefOid' : 'baseRefOid'] = 'c'.repeat(40);
      return { status: 0, stdout: JSON.stringify(pull) };
    }
    if (args[0] === 'pr' && args[1] === 'checks') {
      if (options.checks) return { status: 1, stdout: '', stderr: options.checks === 'absent'
        ? "no required checks reported on the 'feature' branch\n" : 'HTTP 403: denied' };
      return { status: 0, stdout: JSON.stringify(evidence().checks) };
    }
    page++;
    const hasNextPage = page < (options.pages ?? 2);
    return { status: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: {
      headRefOid: head, baseRefOid: base,
      reviewThreads: { nodes: page === 2 ? [{ id: 'late', isResolved: false }] : [], pageInfo: { hasNextPage, endCursor: `t${page}` } },
      reviews: { nodes: page === 1 ? evidence().reviews : [], pageInfo: { hasNextPage: false, endCursor: null } },
    } } } }) };
  };
  return { calls, run };
}

describe('read-only readiness collection', () => {
  it('paginates threads and returns late blockers without GitHub mutations', () => {
    const fixture = collectorFixture();
    const report = collectReadiness('2798', { run: fixture.run });
    expect(report.blockers).toContain('1 unresolved review thread(s)');
    expect(fixture.calls.filter(call => call.args[0] === 'api')).toHaveLength(2);
    expect(fixture.calls.some(call => call.args.includes('record') || call.args.includes('ready') || call.args.includes('merge'))).toBe(false);
    expect(fixture.calls.find(call => call.command === process.execPath)?.args).toEqual(expect.arrayContaining(['check', '2798']));
  });

  it.each(['head', 'base'] as const)('fails closed when %s changes during collection', race => {
    const fixture = collectorFixture({ race });
    expect(() => collectReadiness('2798', { run: fixture.run })).toThrow(/changed/);
  });

  it('fails closed on unavailable data, malformed API results and unbounded pagination', () => {
    expect(() => collectReadiness('2798', collectorFixture({ failure: true }))).toThrow();
    expect(() => collectReadiness('2798', { run: () => ({ status: 0, stdout: '{}' }) })).toThrow();
    expect(() => collectReadiness('2798', collectorFixture({ pages: 100 }))).toThrow(/pagination/);
  });

  it('reports no required checks as missing evidence but preserves access errors as unknown', () => {
    expect(collectReadiness('2798', collectorFixture({ checks: 'absent' })).blockers)
      .toContain('required checks are unavailable or empty');
    expect(() => collectReadiness('2798', collectorFixture({ checks: 'denied' }))).toThrow();
  });

  it('rejects option injection and repository substitution before executing anything', () => {
    const fixture = collectorFixture();
    expect(() => collectReadiness('--help', fixture)).toThrow();
    expect(() => collectReadiness('2798', { ...fixture, repository: 'bad;repo' })).toThrow();
    expect(fixture.calls).toHaveLength(0);
  });
});
