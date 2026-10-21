import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import {
  AccessError,
  FailClosed,
  MAX_RECEIPTS,
  RECEIPT_MARKER,
  contextDiffId,
  decideCarryOver,
  fetchPull,
  forkPoint,
  gitRunner,
  introducesReview,
  parseGreptileSummary,
  pullContexts,
  readReceipts,
  recentBaseChange,
  receiptFor,
  renderReceipts,
  replayPull,
  replayTree,
  treeOf,
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
    // Attributes in the checkout under review must not turn the conflict into a union merge.
    writeFileSync(join(r.root, '.gitattributes'), '* merge=union\n');
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
    expect(() => forkPoint(r.git, a2, [b2])).toThrow('Ambiguous base');
    expect(() => forkPoint(r.git, a2, [a1, b2])).toThrow(FailClosed);
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

const replayOk = (git: ReturnType<typeof gitRunner>, pr: number, view: { headRefOid: string; baseRefName: string; baseRefOid: string }, receipt: { reviewed: string; base: string; reviews: number; recordedAt: string }) => {
  const trees = replayPull(git, pr, view, receipt);
  if (trees.replayed === null || trees.replayed !== trees.head) return false;
  const ids = pullContexts(git, view, receipt, trees);
  return ids.reviewed === ids.head;
};

describe('receipts against a remote', () => {
  it('records at review time and carries across a force-pushed restack of the stack', () => {
    const r = remoteStack();
    r.publish(2);
    const receipt = receiptFor(r.clone().git, 2, r.view(), r.reviewed, 1, new Date(0));
    expect(receipt).toEqual({ reviewed: r.reviewed, base: r.parent, reviews: 1, recordedAt: '1970-01-01T00:00:00.000Z' });
    r.run('checkout', '-q', 'parent');
    r.amend('p.ts', 'parent v2 after review fixes\n');
    r.run('rebase', '-q', '--onto', 'parent', r.parent, 'child');
    r.publish(2);
    expect(replayOk(r.clone().git, 2, r.view(), receipt)).toBe(true);
  });

  it('fetches the reported head by SHA when the pull ref lags behind it', () => {
    const r = remoteStack();
    r.publish(5);
    const receipt = receiptFor(r.clone().git, 5, r.view(), r.reviewed, 1);
    r.run('commit', '-q', '--amend', '-m', 'child, reworded');
    r.run('push', '-q', '--force', 'origin', 'child');
    expect(replayOk(r.clone().git, 5, r.view(), receipt)).toBe(true);
  });

  it('detects new work pushed after the review', () => {
    const r = remoteStack();
    r.publish(3);
    const receipt = receiptFor(r.clone().git, 3, r.view(), r.reviewed, 1);
    r.commit('app.ts', 'one\ntwo\nthree\nfour\nfive\nsix\nseven\n', 'new work');
    r.publish(3);
    expect(replayOk(r.clone().git, 3, r.view(), receipt)).toBe(false);
  });

  it('rejects an unchanged head retargeted so parent commits join the PR diff', () => {
    const r = remoteStack();
    r.publish(6);
    const receipt = receiptFor(r.clone().git, 6, r.view(), r.reviewed, 1);
    const retargeted = { ...r.view(), baseRefName: 'main', baseRefOid: r.run('rev-parse', 'main') };
    expect(retargeted.headRefOid).toBe(r.reviewed);
    expect(replayOk(r.clone().git, 6, retargeted, receipt)).toBe(false);
  });

  it('refuses a recorded base that is not behind the reviewed commit', () => {
    const r = remoteStack();
    r.commit('app.ts', 'later\n', 'later');
    r.publish(4);
    const forged = { reviewed: r.reviewed, base: r.run('rev-parse', 'child'), reviews: 1, recordedAt: 'x' };
    expect(() => replayPull(r.clone().git, 4, r.view(), forged)).toThrow('not an ancestor');
  });

  it('fails closed, not as an access error, for a commit the remote no longer serves', () => {
    const r = remoteStack();
    r.publish(7);
    expect(() => fetchPull(r.clone().git, 7, 'parent', [sha('e')])).toThrow(FailClosed);
  });

  it('resolves the remote-tracking base even when a local branch shadows its short name', () => {
    const r = remoteStack();
    r.publish(9);
    const c = r.clone();
    const unrelated = c.commit('unrelated.ts', 'x\n', 'unrelated');
    c.run('branch', 'origin/parent');
    expect(receiptFor(c.git, 9, r.view(), r.reviewed, 1).base).toBe(r.parent);
    expect(c.run('rev-parse', 'refs/heads/origin/parent')).toBe(unrelated);
  });

  it('never falls back to a stale cached base when the base fetch fails', () => {
    const r = remoteStack();
    r.publish(10);
    const c = r.clone();
    const receipt = receiptFor(c.git, 10, r.view(), r.reviewed, 1);
    // The parent is reset to main, then deleted, so the next base fetch fails.
    r.run('push', '-q', '--force', 'origin', 'main:parent');
    r.run('push', '-q', 'origin', '--delete', 'parent');
    const reported = { ...r.view(), baseRefOid: r.run('rev-parse', 'main') };
    expect(replayOk(c.git, 10, reported, receipt)).toBe(false);
    // Another check in a sibling worktree left its own base behind; it must not leak in.
    c.run('update-ref', 'refs/review-carryover/base', r.parent);
    expect(replayOk(c.git, 10, reported, receipt)).toBe(false);
  });

  it('trusts the fetched live base over a stale GitHub-reported base', () => {
    const r = remoteStack();
    r.publish(13);
    const c = r.clone();
    const receipt = receiptFor(c.git, 13, r.view(), r.reviewed, 1);
    // The parent is reset to main on the remote while GitHub still reports the old parent tip.
    r.run('push', '-q', '--force', 'origin', 'main:parent');
    expect(replayOk(c.git, 13, r.view(), receipt)).toBe(false);
  });

  it('cleans up its per-run base ref and reports the fetched base', () => {
    const r = remoteStack();
    r.publish(12);
    const c = r.clone();
    expect(fetchPull(c.git, 12, 'parent', [r.reviewed]).base).toBe(r.parent);
    expect(c.run('for-each-ref', 'refs/review-carryover/')).toBe('');
  });

  it('fetches the GitHub-reported base by SHA when its branch is gone', () => {
    const r = remoteStack();
    r.run('checkout', '-q', 'parent');
    const advanced = r.commit('p3.ts', 'parent moved on\n', 'parent advances');
    r.publish(11);
    const view = { ...r.view(), baseRefOid: advanced };
    r.run('push', '-q', 'origin', '--delete', 'parent');
    expect(receiptFor(r.clone().git, 11, view, r.reviewed, 1).base).toBe(r.parent);
  });

  it('keeps working after the base branch is deleted', () => {
    const r = remoteStack();
    r.publish(8);
    const view = r.view();
    r.run('push', '-q', 'origin', '--delete', 'parent');
    expect(receiptFor(r.clone().git, 8, view, r.reviewed, 1).base).toBe(r.parent);
  });

  it('reports an unreachable remote as an access error', () => {
    const c = repo();
    c.run('remote', 'add', 'origin', join(tmpdir(), 'review-carryover-missing-remote'));
    expect(() => fetchPull(c.git, 1, 'main')).toThrow(AccessError);
  });
});

const footer = (reviewed: string, title = 'Merge...', repoPath = 'hamedmp/matrix-os', reviews = 2, trailer = true) =>
  `<sub>Reviews (${reviews}) · Last reviewed commit: ["${title}"](https://github.com/${repoPath}/commit/${reviewed})${trailer ? ' · [Reviewed by Greptile](https://www.greptile.com/)' : ''}</sub>`;
const greptileBody = (score: number, reviewed: string, extra = '', reviews = 2) => [
  `<h2><a href="https://app.greptile.com/api/retrigger?id=1">Retrigger</a>Confidence Score: ${score}/5</h2>`,
  `See [this commit](https://github.com/hamedmp/matrix-os/commit/${sha('9')}) for context.`,
  extra,
  footer(reviewed, 'Merge...', 'hamedmp/matrix-os', reviews),
].join('\n');
const greptile = (body: string, id = 7) => [{ id, user: { login: 'greptile-apps[bot]' }, body }];

describe('Greptile summary parsing', () => {
  it('reads the score heading and the footer link target, not other commit links', () => {
    expect(parseGreptileSummary(greptile(greptileBody(5, sha('a'))), 'HamedMP/matrix-os')).toEqual({ commentId: 7, score: 5, reviewed: sha('a'), reviews: 2 });
  });

  it('accepts the footer without the Reviewed by Greptile trailer', () => {
    const body = `<h2><a href="x"></a>Confidence Score: 5/5</h2>\n${footer(sha('a'), 'fix(chat): x', 'hamedmp/matrix-os', 13, false)}`;
    expect(parseGreptileSummary(greptile(body), 'HamedMP/matrix-os')).toMatchObject({ reviewed: sha('a'), reviews: 13 });
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

describe('base changes around a review', () => {
  const now = Date.parse('2026-10-13T22:00:00Z');
  const at = (minutesAgo: number, event: string) => ({ event, created_at: new Date(now - minutesAgo * 60_000).toISOString() });

  it('flags a retarget or base force-push within the review window', () => {
    expect(recentBaseChange([at(5, 'base_ref_changed')], now)).toBe(true);
    expect(recentBaseChange([at(29, 'base_ref_force_pushed')], now)).toBe(true);
  });

  it('ignores older base changes and unrelated events', () => {
    expect(recentBaseChange([at(31, 'base_ref_changed'), at(1, 'labeled'), at(1, 'head_ref_force_pushed')], now)).toBe(false);
    expect(recentBaseChange([], now)).toBe(false);
  });

  it('treats an unparseable event time as a recent change', () => {
    expect(recentBaseChange([{ event: 'base_ref_changed', created_at: 'garbage' }], now)).toBe(true);
  });
});

describe('review-introducing summary edits', () => {
  const event = (action: string, body: string, from?: string) => ({
    action,
    comment: { id: 7, user: { login: 'greptile-apps[bot]' }, body },
    ...(from === undefined ? {} : { changes: { body: { from } } }),
  });

  it('records a newly created summary and an edit that replaces a placeholder', () => {
    expect(introducesReview(event('created', greptileBody(5, sha('a'))))).toMatchObject({ reviewed: sha('a') });
    expect(introducesReview(event('edited', greptileBody(5, sha('a')), 'Reviewing...'))).toMatchObject({ reviewed: sha('a') });
  });

  it('records a review of another commit or a re-review of the same commit', () => {
    expect(introducesReview(event('edited', greptileBody(5, sha('b'), '', 3), greptileBody(4, sha('a'), '', 2)))).toMatchObject({ reviewed: sha('b') });
    expect(introducesReview(event('edited', greptileBody(5, sha('a'), '', 3), greptileBody(4, sha('a'), '', 2)))).toMatchObject({ reviewed: sha('a'), reviews: 3 });
  });

  it('ignores re-renders that keep the commit and the review count', () => {
    expect(introducesReview(event('edited', greptileBody(5, sha('a'), 'more text', 2), greptileBody(5, sha('a'), '', 2)))).toBeNull();
    expect(introducesReview(event('edited', 'Reviewing...', greptileBody(5, sha('a'))))).toBeNull();
  });
});

describe('base receipts', () => {
  const receipt = (fill: string) => ({ reviewed: sha(fill), base: sha('0'), reviews: 2, recordedAt: '2026-10-13T00:00:00.000Z' });

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
    const uncounted = renderReceipts([{ ...receipt('a'), reviews: null } as unknown as ReturnType<typeof receipt>]);
    expect(readReceipts([{ id: 4, user: { login: 'github-actions[bot]' }, body: uncounted }]).receipts).toEqual([]);
    const broken = `${RECEIPT_MARKER}\n<!-- receipts {not json -->`;
    expect(readReceipts([{ id: 5, user: { login: 'github-actions[bot]' }, body: broken }])).toEqual({ commentId: 5, receipts: [] });
  });

  it('lets the latest review of a commit define its base and stays bounded', () => {
    const id = (i: number) => i.toString(16).padStart(40, '0');
    let receipts: ReturnType<typeof receipt>[] = [];
    for (let i = 0; i < MAX_RECEIPTS + 5; i += 1) receipts = upsertReceipt(receipts, { ...receipt('a'), reviewed: id(i) });
    expect(receipts).toHaveLength(MAX_RECEIPTS);
    expect(receipts.at(-1)?.reviewed).toBe(id(MAX_RECEIPTS + 4));
    expect(upsertReceipt([receipt('a'), receipt('b')], { ...receipt('a'), base: sha('1') })).toEqual([receipt('b'), { ...receipt('a'), base: sha('1') }]);
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
  const receipts = [{ reviewed: sha('a'), base: sha('0'), reviews: 2, recordedAt: 'x' }];
  const matchingTrees = () => ({ replayed: sha('d'), head: sha('d') });
  const matchingContexts = () => ({ reviewed: 'c', head: 'c' });
  const decide = (summary: { score: number; reviewed: string; reviews: number | null } | null, head: string, overrides: Record<string, unknown> = {}) => {
    const replay = vi.fn(matchingTrees);
    const contexts = vi.fn(matchingContexts);
    const result = decideCarryOver({ summary, head, receipts, replay, contexts, ...overrides });
    return { result, replay, contexts };
  };

  it('accepts a 5/5 review of the current head without a receipt, without git work', () => {
    const { result, replay } = decide({ score: 5, reviewed: sha('c'), reviews: 2 }, sha('c'));
    expect(result).toEqual({ ok: true, reason: 'review names the current head' });
    expect(replay).not.toHaveBeenCalled();
  });

  it('verifies the base of a reviewed current head when a receipt exists', () => {
    const { result, replay } = decide({ score: 5, reviewed: sha('a'), reviews: 2 }, sha('a'));
    expect(result).toEqual({ ok: true, reason: 'review names the current head and its base' });
    expect(replay).toHaveBeenCalledWith(receipts[0]);
    const moved = decide({ score: 5, reviewed: sha('a'), reviews: 2 }, sha('a'), { replay: () => ({ replayed: sha('d'), head: sha('f') }) });
    expect(moved.result).toMatchObject({ ok: false });
  });

  it('carries a 5/5 review whose replay and context match the head', () => {
    const { result, contexts } = decide({ score: 5, reviewed: sha('a'), reviews: 2 }, sha('b'));
    expect(result).toEqual({ ok: true, reason: 'head is the reviewed change replayed onto its new base' });
    expect(contexts).toHaveBeenCalledWith(receipts[0], matchingTrees());
  });

  it('requires a fresh review when the head differs from the replay, without diffing context', () => {
    const { result, contexts } = decide({ score: 5, reviewed: sha('a'), reviews: 2 }, sha('b'), { replay: () => ({ replayed: sha('d'), head: sha('f') }) });
    expect(result).toEqual({ ok: false, reason: 'head differs from the reviewed change replayed onto its base' });
    expect(contexts).not.toHaveBeenCalled();
  });

  it('requires a fresh review when the replay conflicts', () => {
    const { result, contexts } = decide({ score: 5, reviewed: sha('a'), reviews: 2 }, sha('b'), { replay: () => ({ replayed: null, head: sha('f') }) });
    expect(result).toEqual({ ok: false, reason: 'reviewed change no longer replays cleanly onto the new base' });
    expect(contexts).not.toHaveBeenCalled();
  });

  it('requires a fresh review when the base changed code next to the reviewed change', () => {
    const { result } = decide({ score: 5, reviewed: sha('a'), reviews: 2 }, sha('b'), { contexts: () => ({ reviewed: 'c', head: 'other' }) });
    expect(result).toEqual({ ok: false, reason: 'base changed code next to the reviewed change' });
  });

  it('ignores a receipt from an earlier review of the same commit', () => {
    // A re-review after a retarget was not recorded: its 5/5 still counts for the head it names.
    const current = decide({ score: 5, reviewed: sha('a'), reviews: 3 }, sha('a'));
    expect(current.result).toEqual({ ok: true, reason: 'review names the current head' });
    expect(current.replay).not.toHaveBeenCalled();
    const older = decide({ score: 5, reviewed: sha('a'), reviews: 3 }, sha('b'));
    expect(older.result).toEqual({ ok: false, reason: 'no base recorded for the reviewed commit' });
    const uncounted = decide({ score: 5, reviewed: sha('a'), reviews: null }, sha('b'));
    expect(uncounted.result).toMatchObject({ ok: false });
    expect(uncounted.replay).not.toHaveBeenCalled();
  });

  it('fails closed without a receipt for an older reviewed commit, before any git work', () => {
    const { result, replay } = decide({ score: 5, reviewed: sha('c'), reviews: 2 }, sha('b'));
    expect(result).toEqual({ ok: false, reason: 'no base recorded for the reviewed commit' });
    expect(replay).not.toHaveBeenCalled();
  });

  it('never passes a review below 5/5 or a missing summary, before any git work', () => {
    for (const [summary, head] of [[{ score: 4, reviewed: sha('a'), reviews: 2 }, sha('b')], [{ score: 4, reviewed: sha('c'), reviews: 2 }, sha('c')], [null, sha('a')]] as const) {
      const { result, replay } = decide(summary, head);
      expect(result).toMatchObject({ ok: false });
      expect(replay).not.toHaveBeenCalled();
    }
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

  it('refuses to record outside the workflow event', () => {
    expect(cli(['record', '1'], { GITHUB_EVENT_PATH: '' }).status).toBe(2);
  });

  it('exits 3, not 1, when the tool hits an unexpected error', () => {
    const bin = mkdtempSync(join(tmpdir(), 'review-carryover-gh-'));
    roots.push(bin);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho not-json\n', { mode: 0o755 });
    const result = cli(['check', '1'], { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(3);
    expect(result.out).toContain('could not decide');
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
    const pinnedAction=/^actions\/checkout@[a-f0-9]{40}$/;expect(checkout?.uses).toMatch(pinnedAction);expect('actions/checkout@v7').not.toMatch(pinnedAction);expect('untrusted/checkout@'+'a'.repeat(40)).not.toMatch(pinnedAction);
    expect(checkout?.with).not.toHaveProperty('ref');
    expect(checkout?.with).toMatchObject({ 'persist-credentials': false, filter: 'tree:0', 'fetch-depth': 0 });
    expect(source).toContain('node scripts/review/review-carryover.mjs record "$PR_NUMBER"');
    expect(source).not.toMatch(/\$\{\{\s*github\.event\.comment\.body/);
  });

  it('serializes receipt writes per pull request', () => {
    expect(workflow.concurrency).toEqual({ group: 'review-receipt-${{ github.event.issue.number }}', 'cancel-in-progress': false });
  });
});
