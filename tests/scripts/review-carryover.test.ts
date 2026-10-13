import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  MAX_RECEIPTS,
  RECEIPT_MARKER,
  addReceipt,
  contextDiffId,
  decideCarryOver,
  forkPoint,
  gitRunner,
  parseGreptileSummary,
  pullTrees,
  readReceipts,
  receiptFor,
  renderReceipts,
  replayTree,
  treeOf,
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
  // Mirrors check: replay reviewed (forked from `base`) onto the head's base,
  // and compare the PR's own diff with context.
  const carries = (reviewed: string, base: string, head: string, ...headBases: string[]) => {
    const newBase = forkPoint(git, head, headBases);
    return replayTree(git, reviewed, base, newBase) === treeOf(git, head)
      && contextDiffId(git, reviewed, base) === contextDiffId(git, head, newBase);
  };
  return { root, git, run, commit, amend, carries };
}

// main <- parent (p.ts) <- child (adds a line to app.ts), the shape of a stack.
function stack() {
  const r = repo();
  r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\n', 'base');
  r.run('checkout', '-q', '-b', 'parent');
  const parent = r.commit('p.ts', 'parent v1\n', 'parent');
  r.run('checkout', '-q', '-b', 'child');
  const reviewed = r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\nsix\n', 'child');
  return { ...r, parent, reviewed };
}

describe('replaying the reviewed change', () => {
  it('carries across a restack after the parent layer is amended', () => {
    const r = stack();
    r.run('checkout', '-q', 'parent');
    const amended = r.amend('p.ts', 'parent v2 after review fixes\n');
    r.run('rebase', '-q', '--onto', 'parent', r.parent, 'child');
    const head = r.run('rev-parse', 'HEAD');
    expect(head).not.toBe(r.reviewed);
    expect(r.carries(r.reviewed, r.parent, head, amended)).toBe(true);
  });

  it('carries across the parent squash-landing on main and the child retargeting to main', () => {
    const r = stack();
    r.run('checkout', '-q', 'main');
    r.run('merge', '-q', '--squash', 'parent');
    r.run('commit', '-q', '-m', 'parent (#1)');
    r.commit('app.ts', 'zero\none\ntwo\nthree\nfour\nfive\n', 'main edits the same file away from the child change');
    r.run('rebase', '-q', '--onto', 'main', r.parent, 'child');
    expect(r.carries(r.reviewed, r.parent, r.run('rev-parse', 'HEAD'), 'main')).toBe(true);
  });

  it('carries across a plain merge of the base into the PR', () => {
    const r = stack();
    r.run('checkout', '-q', 'parent');
    const moved = r.commit('p2.ts', 'parent moves\n', 'parent moves');
    r.run('checkout', '-q', 'child');
    r.run('merge', '-q', '--no-edit', 'parent');
    expect(r.carries(r.reviewed, r.parent, r.run('rev-parse', 'HEAD'), moved)).toBe(true);
  });

  it('carries a message-only amend', () => {
    const r = stack();
    r.run('commit', '-q', '--amend', '-m', 'child, reworded');
    expect(r.carries(r.reviewed, r.parent, r.run('rev-parse', 'HEAD'), r.parent)).toBe(true);
  });

  it('requires a fresh review when the PR adds work after the review', () => {
    const r = stack();
    const head = r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'new work');
    expect(r.carries(r.reviewed, r.parent, head, r.parent)).toBe(false);
  });

  it('requires a fresh review when a restack conflict had to be resolved', () => {
    const r = stack();
    r.run('checkout', '-q', 'parent');
    const amended = r.amend('app.ts', 'one\ntwo\nthree\nfour\nfive\nfive-and-a-half\n');
    expect(() => r.run('rebase', '-q', '--onto', 'parent', r.parent, 'child')).toThrow();
    writeFileSync(join(r.root, 'app.ts'), 'one\ntwo\nthree\nfour\nfive\nfive-and-a-half\nsix\n');
    r.run('add', 'app.ts');
    r.git(['-c', 'core.editor=true', 'rebase', '--continue']);
    expect(replayTree(r.git, r.reviewed, r.parent, amended)).toBeNull();
    expect(r.carries(r.reviewed, r.parent, r.run('rev-parse', 'HEAD'), amended)).toBe(false);
  });

  it('requires a fresh review when an identical edit moves to another function', () => {
    const r = repo();
    const body = 'function guarded() {\n  if (!authorized) return;\n  audit();\n}\n\nfunction open() {\n  render();\n  done();\n}\n';
    r.commit('api.ts', body, 'base');
    const base = r.run('rev-parse', 'HEAD');
    r.run('checkout', '-q', '-b', 'pr');
    const reviewed = r.commit('api.ts', body.replace('  audit();\n', '  audit();\n  deleteAll();\n'), 'guarded delete');
    const moved = r.commit('api.ts', body.replace('  render();\n', '  render();\n  deleteAll();\n'), 'move the delete');
    expect(r.carries(reviewed, base, moved, 'main')).toBe(false);
  });

  it('requires a fresh review when an edit moves between repeated identical blocks', () => {
    const r = repo();
    const block = 'a\nb\nc\nd\ne\nf\n';
    r.commit('routes.ts', block + block, 'base');
    const base = r.run('rev-parse', 'HEAD');
    r.run('checkout', '-q', '-b', 'pr');
    const reviewed = r.commit('routes.ts', 'a\nb\nc\nX\nd\ne\nf\n' + block, 'first block');
    const moved = r.commit('routes.ts', block + 'a\nb\nc\nX\nd\ne\nf\n', 'second block');
    expect(r.carries(reviewed, base, moved, 'main')).toBe(false);
  });

  it('requires a fresh review when the base edits the lines next to the PR change', () => {
    const r = repo();
    r.commit('api.ts', 'start\nif (!authorized) return;\naudit();\nend\n', 'base');
    const base = r.run('rev-parse', 'HEAD');
    r.run('checkout', '-q', '-b', 'pr');
    const reviewed = r.commit('api.ts', 'start\nif (!authorized) return;\naudit();\ndeleteAll();\nend\n', 'guarded delete');
    r.run('checkout', '-q', 'main');
    const dropped = r.commit('api.ts', 'start\naudit();\nend\n', 'base drops the guard');
    r.run('checkout', '-q', 'pr');
    r.run('merge', '-q', '--no-edit', 'main');
    const head = r.run('rev-parse', 'HEAD');
    // git merges this cleanly, so only the context check catches it.
    expect(replayTree(r.git, reviewed, base, dropped)).toBe(treeOf(r.git, head));
    expect(r.carries(reviewed, base, head, 'main')).toBe(false);
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

  it('fails closed when candidates disagree without one containing the other', () => {
    const r = repo();
    r.commit('f.ts', 'root\n', 'root');
    r.run('checkout', '-q', '-b', 'x');
    const x1 = r.commit('x.ts', 'x1\n', 'x1');
    r.run('checkout', '-q', '-b', 'y', 'main');
    const y1 = r.commit('y.ts', 'y1\n', 'y1');
    r.run('checkout', '-q', '-b', 'pr', x1);
    r.run('merge', '-q', '--no-edit', y1);
    const head = r.commit('pr.ts', 'pr\n', 'pr work');
    r.run('checkout', '-q', 'x');
    const x2 = r.commit('x.ts', 'x2\n', 'x2');
    r.run('checkout', '-q', 'y');
    const y2 = r.commit('y.ts', 'y2\n', 'y2');
    expect(() => forkPoint(r.git, head, [x2, y2])).toThrow('Ambiguous base');
  });

  it('rejects a criss-cross history with several best bases', () => {
    const r = repo();
    r.commit('f.ts', 'root\n', 'root');
    r.run('checkout', '-q', '-b', 'a');
    const a1 = r.commit('a.ts', 'a\n', 'a1');
    r.run('checkout', '-q', '-b', 'b', 'main');
    const b1 = r.commit('b.ts', 'b\n', 'b1');
    r.run('merge', '-q', '--no-edit', a1);
    const b2 = r.run('rev-parse', 'HEAD');
    r.run('checkout', '-q', 'a');
    r.run('merge', '-q', '--no-edit', b1);
    const a2 = r.run('rev-parse', 'HEAD');
    expect(() => forkPoint(r.git, a2, [b2])).toThrow('No usable base');
  });
});

// A bare "GitHub" remote that serves refs/pull/<n>/head and, like GitHub,
// lets clients fetch force-pushed commits by SHA.
function remoteStack() {
  const r = stack();
  const remote = mkdtempSync(join(tmpdir(), 'review-carryover-remote-'));
  roots.push(remote);
  r.git(['init', '-q', '--bare', remote]);
  gitRunner(remote)(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  r.run('remote', 'add', 'origin', remote);
  const publish = (pr: number) => r.run('push', '-q', '--force', 'origin', 'main', 'parent', 'child', `child:refs/pull/${pr}/head`);
  const clone = () => {
    const c = repo();
    c.run('remote', 'add', 'origin', remote);
    return c;
  };
  const view = () => ({ headRefOid: r.run('rev-parse', 'child'), baseRefName: 'parent', baseRefOid: r.run('rev-parse', 'parent') });
  return { ...r, publish, clone, view };
}

describe('receipts against a remote', () => {
  it('records at review time and carries across a force-pushed restack of the stack', () => {
    const r = remoteStack();
    r.publish(2);
    const receipt = receiptFor(r.clone().git, 2, r.view(), r.reviewed, new Date(0));
    expect(receipt).toEqual({ reviewed: r.reviewed, base: r.parent, recordedAt: '1970-01-01T00:00:00.000Z' });
    r.run('checkout', '-q', 'parent');
    r.amend('p.ts', 'parent v2 after review fixes\n');
    r.run('rebase', '-q', '--onto', 'parent', r.parent, 'child');
    r.publish(2);
    const trees = pullTrees(r.clone().git, 2, r.view(), receipt);
    expect(trees.replayed).toBe(trees.head);
    expect(trees.headContext).toBe(trees.reviewedContext);
  });

  it('fetches the reported head by SHA when the pull ref lags behind it', () => {
    const r = remoteStack();
    r.publish(5);
    const receipt = receiptFor(r.clone().git, 5, r.view(), r.reviewed);
    r.run('commit', '-q', '--amend', '-m', 'child, reworded');
    r.run('push', '-q', '--force', 'origin', 'child');
    const trees = pullTrees(r.clone().git, 5, r.view(), receipt);
    expect(trees.replayed).toBe(trees.head);
  });

  it('detects new work pushed after the review', () => {
    const r = remoteStack();
    r.publish(3);
    const receipt = receiptFor(r.clone().git, 3, r.view(), r.reviewed);
    r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'new work');
    r.publish(3);
    const trees = pullTrees(r.clone().git, 3, r.view(), receipt);
    expect(trees.replayed).not.toBe(trees.head);
  });

  it('refuses a recorded base that is not behind the reviewed commit', () => {
    const r = remoteStack();
    r.commit('app.ts', 'later\n', 'later');
    r.publish(4);
    const forged = { reviewed: r.reviewed, base: r.run('rev-parse', 'child'), recordedAt: 'x' };
    expect(() => pullTrees(r.clone().git, 4, r.view(), forged)).toThrow('not an ancestor');
  });
});

const footer = (reviewed: string, title = 'Merge...', repoPath = 'hamedmp/matrix-os') =>
  `<sub>Reviews (2) · Last reviewed commit: ["${title}"](https://github.com/${repoPath}/commit/${reviewed}) · [Reviewed by Greptile](https://www.greptile.com/)</sub>`;
const greptileBody = (score: number, reviewed: string, extra = '') => [
  `<h2><a href="https://app.greptile.com/api/retrigger?id=1">Retrigger</a>Confidence Score: ${score}/5</h2>`,
  `See [this commit](https://github.com/hamedmp/matrix-os/commit/${sha('9')}) for context.`,
  extra,
  footer(reviewed),
].join('\n');
const greptile = (body: string, id = 7) => [{ id, user: { login: 'greptile-apps[bot]' }, body }];

describe('Greptile summary parsing', () => {
  it('reads the score heading and the footer link target, not other commit links', () => {
    expect(parseGreptileSummary(greptile(greptileBody(5, sha('a'))), 'HamedMP/matrix-os')).toEqual({ commentId: 7, score: 5, reviewed: sha('a') });
  });

  it('ignores a commit link spoofed inside the reviewed commit title', () => {
    const body = [
      '<h2>Confidence Score: 5/5</h2>',
      footer(sha('a'), `x](https://github.com/hamedmp/matrix-os/commit/${sha('b')}) · [Reviewed by Greptile](https://x) y`),
    ].join('\n');
    expect(parseGreptileSummary(greptile(body), 'HamedMP/matrix-os')?.reviewed).toBe(sha('a'));
  });

  it('fails closed when prose repeats a score heading or the footer', () => {
    expect(parseGreptileSummary(greptile(greptileBody(2, sha('a'), 'Quoted: Confidence Score: 5/5</h3>')))).toBeNull();
    expect(parseGreptileSummary(greptile(greptileBody(5, sha('a'), 'Last reviewed commit: see below')))).toBeNull();
    expect(parseGreptileSummary(greptile(greptileBody(2, sha('a'), 'Prose says Confidence Score: 5/5 here')))?.score).toBe(2);
  });

  it('rejects a footer that links another repository', () => {
    const body = `<h2>Confidence Score: 5/5</h2>\n${footer(sha('a'), 'x', 'someone/fork')}`;
    expect(parseGreptileSummary(greptile(body), 'HamedMP/matrix-os')).toBeNull();
  });

  it('ignores lookalike summaries from anyone but Greptile', () => {
    const comments = [...greptile(greptileBody(3, sha('a')), 1), { id: 2, user: { login: 'someone' }, body: greptileBody(5, sha('b')) }];
    expect(parseGreptileSummary(comments)).toMatchObject({ score: 3, reviewed: sha('a') });
  });

  it('returns null when Greptile has not summarized the PR', () => {
    expect(parseGreptileSummary(greptile('Reviewing...'))).toBeNull();
  });
});

describe('base receipts', () => {
  const receipt = (fill: string) => ({ reviewed: sha(fill), base: sha('0'), recordedAt: '2026-10-13T00:00:00.000Z' });

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

  it('keeps the first receipt for a reviewed commit and stays bounded', () => {
    const id = (i: number) => i.toString(16).padStart(40, '0');
    let receipts: ReturnType<typeof receipt>[] = [];
    for (let i = 0; i < MAX_RECEIPTS + 5; i += 1) receipts = addReceipt(receipts, { ...receipt('a'), reviewed: id(i) });
    expect(receipts).toHaveLength(MAX_RECEIPTS);
    expect(receipts.at(-1)?.reviewed).toBe(id(MAX_RECEIPTS + 4));
    expect(addReceipt([receipt('a'), receipt('b')], { ...receipt('a'), base: sha('1') })).toEqual([receipt('a'), receipt('b')]);
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
  const receipts = [{ reviewed: sha('a'), base: sha('0'), recordedAt: 'x' }];
  const matching = () => ({ replayed: sha('d'), head: sha('d'), reviewedContext: 'c', headContext: 'c' });

  it('accepts a 5/5 review of the current head without replaying', () => {
    const trees = vi.fn(matching);
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('a'), receipts: [], trees }))
      .toEqual({ ok: true, reason: 'review names the current head' });
    expect(trees).not.toHaveBeenCalled();
  });

  it('carries a 5/5 review whose replay equals the head tree', () => {
    const trees = vi.fn(matching);
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('b'), receipts, trees })).toMatchObject({ ok: true });
    expect(trees).toHaveBeenCalledWith(receipts[0]);
  });

  it('requires a fresh review when the head differs from the replay', () => {
    const trees = () => ({ ...matching(), head: sha('f') });
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('b'), receipts, trees }))
      .toEqual({ ok: false, reason: 'head differs from the reviewed change replayed onto its base' });
  });

  it('requires a fresh review when the replay conflicts', () => {
    const trees = () => ({ ...matching(), replayed: null });
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('b'), receipts, trees }))
      .toEqual({ ok: false, reason: 'reviewed change no longer replays cleanly onto the new base' });
  });

  it('requires a fresh review when the base changed code next to the reviewed change', () => {
    const trees = () => ({ ...matching(), headContext: 'other' });
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('a') }, head: sha('b'), receipts, trees }))
      .toEqual({ ok: false, reason: 'base changed code next to the reviewed change' });
  });

  it('fails closed without a receipt for the reviewed commit, before any git work', () => {
    const trees = vi.fn(matching);
    expect(decideCarryOver({ summary: { score: 5, reviewed: sha('c') }, head: sha('b'), receipts, trees }))
      .toEqual({ ok: false, reason: 'no base recorded for the reviewed commit' });
    expect(trees).not.toHaveBeenCalled();
  });

  it('never passes a review below 5/5 or a missing summary, before any git work', () => {
    const trees = vi.fn(matching);
    expect(decideCarryOver({ summary: { score: 4, reviewed: sha('a') }, head: sha('b'), receipts, trees })).toMatchObject({ ok: false });
    expect(decideCarryOver({ summary: { score: 4, reviewed: sha('a') }, head: sha('a'), receipts, trees })).toMatchObject({ ok: false });
    expect(decideCarryOver({ summary: null, head: sha('a'), receipts, trees })).toMatchObject({ ok: false });
    expect(trees).not.toHaveBeenCalled();
  });
});

describe('command line', () => {
  const cli = (args: string[], env: Record<string, string> = {}) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, ['scripts/review/review-carryover.mjs', ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, ...env } }) };
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      return { status: failure.status, out: failure.stderr };
    }
  };

  it('exits 2 on bad usage', () => {
    expect(cli(['bogus', '1']).status).toBe(2);
    expect(cli(['check', '0']).status).toBe(2);
  });

  it('exits 3, not 1, when GitHub cannot be reached', () => {
    const result = cli(['check', '1'], { PATH: '/nonexistent', GH_TOKEN: 'x' });
    expect(result.status).toBe(3);
    expect(result.out).toContain('could not decide');
  });
});

describe('review receipt workflow', () => {
  const source = readFileSync(join(process.cwd(), '.github/workflows/review-receipt.yml'), 'utf8');
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
    expect(checkout?.with).toMatchObject({ 'persist-credentials': false, filter: 'tree:0', 'fetch-depth': 0 });
    expect(source).toContain('node scripts/review/review-carryover.mjs record "$PR_NUMBER"');
    expect(source).not.toMatch(/\$\{\{\s*github\.event\.comment\.body/);
  });

  it('serializes receipt writes per pull request', () => {
    expect(workflow.concurrency).toEqual({ group: 'review-receipt-${{ github.event.issue.number }}', 'cancel-in-progress': false });
  });
});
