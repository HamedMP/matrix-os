#!/usr/bin/env node
// Decide whether a PR's Greptile review still covers its current head.
//
// `record <pr>` runs from .github/workflows/review-fingerprint.yml whenever
// Greptile edits its summary. It stores the base each reviewed commit forked
// from in a PR comment. The base has to be captured then: a stack restack
// force-pushes the parent, after which the reviewed commit's old base is no
// longer on any branch.
//
// `check <pr>` passes a 5/5 review when it names the head, or when the head's
// own diff against its current base equals the reviewed commit's own diff
// against its recorded base. Both diffs are recomputed by the same git, so a
// receipt only names commits and never vouches for content. Restacks,
// retargets after a parent lands, and base merges keep the PR's own diff and
// so keep the review; new work, moved edits, conflict resolutions, or base
// edits next to the PR's changes alter it and need a fresh review.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 256 * 1024 * 1024;
export const GREPTILE_LOGIN = 'greptile-apps[bot]';
export const RECEIPT_LOGIN = 'github-actions[bot]';
export const RECEIPT_MARKER = '<!-- matrix-review-fingerprint v1 -->';
export const MAX_RECEIPTS = 30;

export function gitRunner(cwd) {
  return args => execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 120_000});
}

export function isAncestor(git, ancestor, descendant) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

// merge-base exits 1 for unrelated histories and 128 for an object this clone
// does not have; both make the candidate unusable rather than fatal. A
// criss-cross history has several best bases, so no single fork point exists.
function uniqueMergeBase(git, a, b) {
  try {
    const bases = git(['merge-base', '--all', a, b]).trim().split('\n').filter(Boolean);
    return bases.length === 1 ? bases[0] : null;
  } catch (error) {
    if (error?.status === 1 || error?.status === 128) return null;
    throw error;
  }
}

// The PR head forked from whichever base candidate sits closest to it: the
// recorded PR base SHA can lag the live branch, and either may be missing.
// Candidates that disagree without one containing the other fail closed.
export function forkPoint(git, sha, candidates) {
  const bases = [...new Set(candidates.map(candidate => uniqueMergeBase(git, candidate, sha)).filter(Boolean))];
  if (bases.length === 0) throw new Error('No usable base for the PR head');
  const closest = bases.find(base => bases.every(other => isAncestor(git, other, base)));
  if (!closest) throw new Error('Ambiguous base for the PR head');
  return closest;
}

// Diff with three context lines and no line numbers or blob ids: base commits
// that shift or edit lines away from the PR's changes keep the id, while an
// edit that moves, changes, or loses its surrounding code alters it.
// Flags and config overrides pin every setting that changes diff output.
export function prOwnDiffId(git, sha, base) {
  const diff = git([
    '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false',
    'diff', '--binary', '--full-index', '--unified=3', '--inter-hunk-context=0', '--indent-heuristic',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers',
    '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '-O/dev/null',
    base, sha,
  ]);
  const normalized = diff
    .replace(/^@@ [^@]* @@.*$/gm, '@@')
    .replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, 'index');
  return createHash('sha256').update(normalized).digest('hex');
}

export function parseGreptileSummary(comments) {
  const summary = comments.filter(comment => comment.user?.login === GREPTILE_LOGIN && /Confidence Score:/.test(comment.body || '')).at(-1);
  if (!summary) return null;
  const score = summary.body.match(/Confidence Score: ([0-5])\/5/)?.[1];
  const reviewed = summary.body.match(/Last reviewed commit:[^\n]*?\/commit\/([0-9a-f]{40})\)/)?.[1];
  if (score === undefined || !reviewed) return null;
  return {commentId: summary.id, score: Number(score), reviewed};
}

const validReceipt = value => value && SHA.test(value.reviewed) && SHA.test(value.base) && typeof value.recordedAt === 'string';

// Fork PRs cannot post as the workflow token. Repository writers can, but they
// can also merge without Greptile, and check recomputes every diff anyway.
export function readReceipts(comments) {
  const comment = comments.find(entry => entry.user?.login === RECEIPT_LOGIN && (entry.body || '').startsWith(RECEIPT_MARKER));
  if (!comment) return {commentId: null, receipts: []};
  const json = comment.body.match(/<!-- receipts (.*) -->/)?.[1];
  if (!json) return {commentId: comment.id, receipts: []};
  try {
    const parsed = JSON.parse(json);
    const receipts = Array.isArray(parsed?.receipts) ? parsed.receipts.filter(validReceipt) : [];
    return {commentId: comment.id, receipts: receipts.slice(-MAX_RECEIPTS)};
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn(`review-carryover: ignoring malformed receipt comment ${comment.id}: ${error.message}`);
    return {commentId: comment.id, receipts: []};
  }
}

export function renderReceipts(receipts) {
  return [
    RECEIPT_MARKER,
    'Greptile review base receipts for `scripts/review/review-carryover.mjs`. Maintained by the Review Fingerprint workflow; do not edit.',
    `<!-- receipts ${JSON.stringify({v: 1, receipts})} -->`,
  ].join('\n');
}

// The first receipt for a reviewed commit wins: it was taken closest to the
// review, before a later restack could move the base out from under it.
export function addReceipt(receipts, receipt) {
  if (receipts.some(entry => entry.reviewed === receipt.reviewed)) return receipts;
  return [...receipts, receipt].slice(-MAX_RECEIPTS);
}

// `fingerprints(receipt)` is only called once score and receipt allow a carry,
// and returns the reviewed and head own-diff ids.
export function decideCarryOver({summary, head, receipts, fingerprints}) {
  if (!summary) return {ok: false, reason: 'no Greptile summary'};
  if (summary.score !== 5) return {ok: false, reason: `Greptile score is ${summary.score}/5`};
  if (summary.reviewed === head) return {ok: true, reason: 'review names the current head'};
  const receipt = receipts.find(entry => entry.reviewed === summary.reviewed);
  if (!receipt) return {ok: false, reason: 'no base recorded for the reviewed commit'};
  const ids = fingerprints(receipt);
  if (ids.reviewed !== ids.head) return {ok: false, reason: 'PR diff changed since the review'};
  return {ok: true, reason: 'head keeps the reviewed PR diff; only its base changed'};
}

function gh(args, input) {
  return execFileSync('gh', args, {encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 60_000, ...(input ? {input} : {})});
}

function loadPull(repo, pr) {
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,baseRefName,baseRefOid']));
  const comments = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp'])).flat();
  return {view, comments};
}

function fetchRefs(git, pr, baseRefName, shas = []) {
  git(['fetch', '--quiet', '--no-tags', 'origin',
    `+refs/heads/${baseRefName}:refs/remotes/origin/${baseRefName}`,
    `+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`,
    ...shas]);
}

// `view` is the PR's headRefOid/baseRefName/baseRefOid as GitHub reports them.
export function receiptFor(git, pr, view, reviewed, now = new Date()) {
  // The reviewed commit is usually the PR head; an older one is fetched by SHA.
  fetchRefs(git, pr, view.baseRefName, reviewed === view.headRefOid ? [] : [reviewed]);
  const base = forkPoint(git, reviewed, [view.baseRefOid, `origin/${view.baseRefName}`]);
  return {reviewed, base, recordedAt: now.toISOString()};
}

export function pullFingerprints(git, pr, view, receipt) {
  fetchRefs(git, pr, view.baseRefName, [receipt.reviewed, receipt.base]);
  if (!isAncestor(git, receipt.base, receipt.reviewed)) throw new Error('Recorded base is not an ancestor of the reviewed commit');
  const headBase = forkPoint(git, view.headRefOid, [view.baseRefOid, `origin/${view.baseRefName}`]);
  return {reviewed: prOwnDiffId(git, receipt.reviewed, receipt.base), head: prOwnDiffId(git, view.headRefOid, headBase)};
}

function record(repo, pr, git) {
  const {view, comments} = loadPull(repo, pr);
  const summary = parseGreptileSummary(comments);
  if (!summary) {
    console.log(JSON.stringify({pr: Number(pr), recorded: false, reason: 'no Greptile summary'}));
    return 0;
  }
  const existing = readReceipts(comments);
  if (existing.receipts.some(entry => entry.reviewed === summary.reviewed)) {
    console.log(JSON.stringify({pr: Number(pr), recorded: false, reason: 'base already recorded', reviewed: summary.reviewed}));
    return 0;
  }
  const receipt = receiptFor(git, pr, view, summary.reviewed);
  const body = JSON.stringify({body: renderReceipts(addReceipt(existing.receipts, receipt))});
  const endpoint = existing.commentId ? `repos/${repo}/issues/comments/${existing.commentId}` : `repos/${repo}/issues/${pr}/comments`;
  gh(['api', '--method', existing.commentId ? 'PATCH' : 'POST', endpoint, '--input', '-'], body);
  console.log(JSON.stringify({pr: Number(pr), recorded: true, score: summary.score, ...receipt}));
  return 0;
}

function check(repo, pr, git) {
  const {view, comments} = loadPull(repo, pr);
  const summary = parseGreptileSummary(comments);
  const {receipts} = readReceipts(comments);
  const fingerprints = receipt => pullFingerprints(git, pr, view, receipt);
  let result;
  try {
    result = decideCarryOver({summary, head: view.headRefOid, receipts, fingerprints});
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(`review-carryover: could not fingerprint PR ${pr}: ${error.message.split('\n')[0]}`);
    result = {ok: false, reason: 'could not fingerprint the reviewed or head diff'};
  }
  console.log(JSON.stringify({pr: Number(pr), score: summary ? `${summary.score}/5` : null, reviewed: summary?.reviewed ?? null, head: view.headRefOid, ...result}));
  return result.ok ? 0 : 1;
}

function main() {
  const [command, pr] = process.argv.slice(2);
  if (!['record', 'check'].includes(command) || !/^[1-9][0-9]{0,6}$/.test(pr || '')) {
    console.error('usage: node scripts/review/review-carryover.mjs <record|check> <pr-number>');
    return 2;
  }
  const repo = process.env.GITHUB_REPOSITORY || 'HamedMP/matrix-os';
  const git = gitRunner(process.cwd());
  return command === 'record' ? record(repo, pr, git) : check(repo, pr, git);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main());
