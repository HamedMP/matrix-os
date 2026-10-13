import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  MAX_RECEIPTS,
  RECEIPT_MARKER,
  decideCarryOver,
  forkPoint,
  gitRunner,
  parseGreptileSummary,
  prOwnDiffId,
  readReceipts,
  renderReceipts,
  upsertReceipt,
} from '../../scripts/review/review-carryover.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha = (fill: string) => fill.repeat(40).slice(0, 40);

function repo() {
  const root = mkdtempSync(join(tmpdir(), 'review-carryover-'));
  roots.push(root);
  const git = gitRunner(root);
  const run = (...args: string[]) => git(args).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com');
  run('config', 'user.name', 't');
  run('config', 'commit.gpgsign', 'false');
  run('config', 'core.hooksPath', '/dev/null');
  const commit = (file: string, body: string, message: string) => {
    writeFileSync(join(root, file), body);
    run('add', file);
    run('commit', '-q', '-m', message);
    return run('rev-parse', 'HEAD');
  };
  const amend = (file: string, body: string) => {
    writeFileSync(join(root, file), body);
    run('add', file);
    run('commit', '-q', '--amend', '--no-edit');
    return run('rev-parse', 'HEAD');
  };
  const fingerprint = (head: string, ...bases: string[]) => prOwnDiffId(git, head, forkPoint(git, head, bases));
  return { root, git, run, commit, amend, fingerprint };
}

// main <- parent (p.ts) <- child (adds a line to app.ts), the shape of a Graphite stack.
function stack() {
  const r = repo();
  r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\n', 'base');
  r.run('checkout', '-q', '-b', 'parent');
  const parent = r.commit('p.ts', 'parent v1\n', 'parent');
  r.run('checkout', '-q', '-b', 'child');
  const reviewed = r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n', 'child');
  return { ...r, parent, reviewed, reviewedId: r.fingerprint(reviewed, parent) };
}

describe('PR own-diff fingerprint', () => {
  it('survives a restack after the parent layer is amended', () => {
    const r = stack();
    r.run('checkout', '-q', 'parent');
    const amended = r.amend('p.ts', 'parent v2 after review fixes\n');
    r.run('rebase', '-q', '--onto', 'parent', r.parent, 'child');
    const head = r.run('rev-parse', 'HEAD');
    expect(head).not.toBe(r.reviewed);
    expect(r.fingerprint(head, amended)).toBe(r.reviewedId);
  });

  it('survives the parent squash-landing on main and the child retargeting to main', () => {
    const r = stack();
    r.run('checkout', '-q', 'main');
    r.run('merge', '-q', '--squash', 'parent');
    r.run('commit', '-q', '-m', 'parent (#1)');
    r.commit('app.ts', 'zero\none\ntwo\nthree\nfour\nfive\n', 'main edits above the child change');
    r.run('rebase', '-q', '--onto', 'main', r.parent, 'child');
    expect(r.fingerprint(r.run('rev-parse', 'HEAD'), 'main')).toBe(r.reviewedId);
  });

  it('survives a plain merge of the base into the PR', () => {
    const r = stack();
    r.run('checkout', '-q', 'parent');
    const moved = r.commit('p2.ts', 'parent moves\n', 'parent moves');
    r.run('checkout', '-q', 'child');
    r.run('merge', '-q', '--no-edit', 'parent');
    expect(r.fingerprint(r.run('rev-parse', 'HEAD'), moved)).toBe(r.reviewedId);
  });

  it('changes when the PR adds work after the review', () => {
    const r = stack();
    const head = r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'new work');
    expect(r.fingerprint(head, r.parent)).not.toBe(r.reviewedId);
  });

  it('changes when a restack conflict resolution rewrites what the PR adds', () => {
    const r = stack();
    r.run('checkout', '-q', 'parent');
    const amended = r.amend('app.ts', 'one\ntwo\nthree\nfour\nfive\nfive-and-a-half\n');
    expect(() => r.run('rebase', '-q', '--onto', 'parent', r.parent, 'child')).toThrow();
    writeFileSync(join(r.root, 'app.ts'), 'one\ntwo\nthree\nfour\nfive\nfive-and-a-half\nSIX\n');
    r.run('add', 'app.ts');
    r.git(['-c', 'core.editor=true', 'rebase', '--continue']);
    expect(r.fingerprint(r.run('rev-parse', 'HEAD'), amended)).not.toBe(r.reviewedId);
  });

  it('distinguishes a change split across hunks from the same lines in one hunk', () => {
    const r = repo();
    r.commit('app.ts', 'a\nb\nc\n', 'base');
    r.run('checkout', '-q', '-b', 'split');
    const split = r.commit('app.ts', 'a\nX\nb\nY\nc\n', 'two hunks');
    r.run('checkout', '-q', 'main');
    r.run('checkout', '-q', '-b', 'joined');
    const joined = r.commit('app.ts', 'a\nX\nY\nb\nc\n', 'one hunk');
    expect(r.fingerprint(split, 'main')).not.toBe(r.fingerprint(joined, 'main'));
  });
});

describe('fork point selection', () => {
  it('prefers the candidate closest to the PR head', () => {
    const r = stack();
    const root = r.run('rev-parse', 'main');
    expect(forkPoint(r.git, r.reviewed, ['main', r.parent])).toBe(r.parent);
    expect(forkPoint(r.git, r.reviewed, [r.parent, 'main'])).toBe(r.parent);
    expect(forkPoint(r.git, r.reviewed, ['main'])).toBe(root);
  });

  it('skips candidates that are not available locally', () => {
    const r = stack();
    expect(forkPoint(r.git, r.reviewed, [sha('e'), r.parent])).toBe(r.parent);
    expect(() => forkPoint(r.git, r.reviewed, [sha('e')])).toThrow('No usable base');
  });
});

const greptileBody = (score: number, reviewed: string) => [
  `<h2><a href="https://app.greptile.com/api/retrigger?id=1">Retrigger</a>Confidence Score: ${score}/5</h2>`,
  `See [this commit](https://github.com/hamedmp/matrix-os/commit/${sha('9')}) for context.`,
  `<sub>Reviews (2) · Last reviewed commit: ["Merge..."](https://github.com/hamedmp/matrix-os/commit/${reviewed}) · [Reviewed by Greptile](https://www.greptile.com/)</sub>`,
].join('\n');

describe('Greptile summary parsing', () => {
  it('reads the score and the last reviewed commit, not other commit links', () => {
    const comments = [{ id: 7, user: { login: 'greptile-apps[bot]' }, body: greptileBody(5, sha('a')) }];
    expect(parseGreptileSummary(comments)).toEqual({ commentId: 7, score: 5, reviewed: sha('a') });
  });

  it('ignores lookalike summaries from anyone but Greptile', () => {
    const comments = [
      { id: 1, user: { login: 'greptile-apps[bot]' }, body: greptileBody(3, sha('a')) },
      { id: 2, user: { login: 'someone' }, body: greptileBody(5, sha('b')) },
    ];
    expect(parseGreptileSummary(comments)).toMatchObject({ score: 3, reviewed: sha('a') });
  });

  it('returns null when Greptile has not summarized the PR', () => {
    expect(parseGreptileSummary([{ id: 1, user: { login: 'greptile-apps[bot]' }, body: 'Reviewing...' }])).toBeNull();
  });
});

describe('fingerprint receipts', () => {
  const receipt = (fill: string) => ({ reviewed: sha(fill), base: sha('0'), diffId: 'd'.repeat(64), recordedAt: '2026-10-13T00:00:00.000Z' });

  it('round-trips through the receipt comment', () => {
    const body = renderReceipts([receipt('a')]);
    expect(body.startsWith(RECEIPT_MARKER)).toBe(true);
    expect(readReceipts([{ id: 4, user: { login: 'github-actions[bot]' }, body }])).toEqual({ commentId: 4, receipts: [receipt('a')] });
  });

  it('trusts only receipts written by the workflow token', () => {
    const body = renderReceipts([receipt('a')]);
    expect(readReceipts([{ id: 4, user: { login: 'someone' }, body }])).toEqual({ commentId: null, receipts: [] });
  });

  it('drops malformed receipt entries', () => {
    const body = renderReceipts([receipt('a')]).replace(sha('a'), 'not-a-sha');
    expect(readReceipts([{ id: 4, user: { login: 'github-actions[bot]' }, body }]).receipts).toEqual([]);
    const broken = `${RECEIPT_MARKER}\n<!-- receipts {not json -->`;
    expect(readReceipts([{ id: 5, user: { login: 'github-actions[bot]' }, body: broken }])).toEqual({ commentId: 5, receipts: [] });
  });

  it('replaces a re-recorded review and stays bounded', () => {
    const id = (i: number) => i.toString(16).padStart(40, '0');
    let receipts: ReturnType<typeof receipt>[] = [];
    for (let i = 0; i < MAX_RECEIPTS + 5; i += 1) receipts = upsertReceipt(receipts, { ...receipt('a'), reviewed: id(i) });
    expect(receipts).toHaveLength(MAX_RECEIPTS);
    expect(receipts.at(-1)?.reviewed).toBe(id(MAX_RECEIPTS + 4));
    const again = upsertReceipt([receipt('a'), receipt('b')], { ...receipt('a'), diffId: 'e'.repeat(64) });
    expect(again).toEqual([receipt('b'), { ...receipt('a'), diffId: 'e'.repeat(64) }]);
  });

  it('reads at most the newest receipts from an oversized comment', () => {
    const id = (i: number) => i.toString(16).padStart(40, '0');
    const many = Array.from({ length: MAX_RECEIPTS + 5 }, (_, i) => ({ ...receipt('a'), reviewed: id(i) }));
    const { receipts } = readReceipts([{ id: 4, user: { login: 'github-actions[bot]' }, body: renderReceipts(many) }]);
    expect(receipts).toHaveLength(MAX_RECEIPTS);
    expect(receipts[0].reviewed).toBe(id(5));
  });
});

describe('carry-over decision', () => {
  const receipts = [{ reviewed: sha('a'), base: sha('0'), diffId: 'd'.repeat(64), recordedAt: 'x' }];

  it('accepts a 5/5 review of the current head without a receipt', () => {
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('a'), headDiffId: null, receipts: [] }))
      .toEqual({ ok: true, reason: 'review names the current head' });
  });

  it('carries a 5/5 review whose recorded fingerprint matches the head', () => {
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('b'), headDiffId: 'd'.repeat(64), receipts }))
      .toMatchObject({ ok: true });
  });

  it('requires a fresh review when the PR diff changed', () => {
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('b'), headDiffId: 'f'.repeat(64), receipts }))
      .toEqual({ ok: false, reason: 'PR diff changed since the review' });
  });

  it('fails closed without a receipt for the reviewed commit', () => {
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('c') }, head: sha('b'), headDiffId: 'd'.repeat(64), receipts }))
      .toEqual({ ok: false, reason: 'no fingerprint recorded for the reviewed commit' });
  });

  it('never passes a review below 5/5 or a missing summary', () => {
    expect(decideCarryOver({ summary: { score: 4, reviewed: sha('a') }, head: sha('a'), headDiffId: null, receipts })).toMatchObject({ ok: false });
    expect(decideCarryOver({ summary: null, head: sha('a'), headDiffId: null, receipts })).toMatchObject({ ok: false });
  });
});

describe('review fingerprint workflow', () => {
  const source = readFileSync(join(process.cwd(), '.github/workflows/review-fingerprint.yml'), 'utf8');
  const workflow = parse(source) as {
    on: Record<string, { types: string[] }>;
    concurrency: { group: string; 'cancel-in-progress': boolean };
    jobs: Record<string, { if: string; permissions: Record<string, string>; 'timeout-minutes': number; steps: Array<Record<string, unknown>> }>;
  };
  const job = workflow.jobs.record;

  it('runs only for Greptile summary comments on pull requests', () => {
    expect(Object.keys(workflow.on)).toEqual(['issue_comment']);
    expect(workflow.on.issue_comment.types).toEqual(['created', 'edited']);
    expect(job.if).toContain("github.event.comment.user.login == 'greptile-apps[bot]'");
    expect(job.if).toContain('github.event.issue.pull_request');
  });

  it('keeps a least-privilege token and never checks out PR code', () => {
    expect(job.permissions).toEqual({ contents: 'read', 'pull-requests': 'write' });
    expect(job['timeout-minutes']).toBeLessThanOrEqual(10);
    const checkout = job.steps.find(step => String(step.uses).startsWith('actions/checkout@'));
    expect(checkout?.uses).toBe('actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803');
    expect(checkout?.with).not.toHaveProperty('ref');
    expect(checkout?.with).toMatchObject({ 'persist-credentials': false });
    expect(source).toContain('node scripts/review/review-carryover.mjs record "$PR_NUMBER"');
    expect(source).not.toMatch(/\$\{\{\s*github\.event\.comment\.body/);
  });

  it('serializes receipt writes per pull request', () => {
    expect(workflow.concurrency).toEqual({ group: 'review-fingerprint-${{ github.event.issue.number }}', 'cancel-in-progress': false });
  });
});
