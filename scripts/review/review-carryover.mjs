#!/usr/bin/env node
// Decide whether a PR's Greptile review still covers its current head.
//
// `record <pr>` runs from .github/workflows/review-fingerprint.yml whenever
// Greptile edits its summary. It fingerprints the reviewed commit's own diff
// against the base it was built on and stores that receipt in a PR comment.
// The fork point has to be captured then: a Graphite restack force-pushes the
// parent, after which the reviewed commit's old base is no longer on any branch.
//
// `check <pr>` passes a 5/5 review when it names the head, or when the head's
// own diff against its current base still matches the recorded fingerprint.
// Restacks, retargets after a parent lands, and base merges keep the PR's own
// diff and so keep the review; new work or a conflict resolution changes it.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const DIFF_ID = /^[0-9a-f]{64}$/;
const MAX_BUFFER = 256 * 1024 * 1024;
export const GREPTILE_LOGIN = 'greptile-apps[bot]';
export const RECEIPT_LOGIN = 'github-actions[bot]';
export const RECEIPT_MARKER = '<!-- matrix-review-fingerprint v1 -->';
export const MAX_RECEIPTS = 30;

export function gitRunner(cwd) {
  return args => execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 120_000});
}

function isAncestor(git, ancestor, descendant) {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw error;
  }
}

// merge-base exits 1 for unrelated histories and 128 for an object this clone
// does not have; both make the candidate unusable rather than fatal.
function mergeBase(git, a, b) {
  try {
    return git(['merge-base', a, b]).trim();
  } catch (error) {
    if (error?.status === 1 || error?.status === 128) return null;
    throw error;
  }
}

// The PR head forked from whichever base candidate sits closest to it: the
// recorded PR base SHA can lag the live branch, and either may be missing.
export function forkPoint(git, sha, candidates) {
  const bases = candidates.map(candidate => mergeBase(git, candidate, sha)).filter(Boolean);
  if (bases.length === 0) throw new Error('No usable base for the PR head');
  return bases.find(base => bases.every(other => isAncestor(git, other, base))) ?? bases[0];
}

// Zero-context diff without hunk positions or blob ids: the base moving or
// editing lines around the PR keeps the id, while any change to what the PR
// adds or removes, or how its edits group into hunks, alters it.
// Flags are explicit so local git config cannot change the result.
export function prOwnDiffId(git, sha, base) {
  const diff = git([
    '-c', 'core.quotePath=true',
    'diff', '--binary', '--full-index', '-U0', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--diff-algorithm=myers', '--src-prefix=a/', '--dst-prefix=b/', '--no-relative',
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

const validReceipt = value => value && SHA.test(value.reviewed) && SHA.test(value.base) && DIFF_ID.test(value.diffId) && typeof value.recordedAt === 'string';

// Only the workflow token may write receipts; anyone can comment on a public PR.
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
    'Greptile review fingerprints for `scripts/review/review-carryover.mjs`. Maintained by the Review Fingerprint workflow; do not edit.',
    `<!-- receipts ${JSON.stringify({v: 1, receipts})} -->`,
  ].join('\n');
}

export function upsertReceipt(receipts, receipt) {
  return [...receipts.filter(entry => entry.reviewed !== receipt.reviewed), receipt].slice(-MAX_RECEIPTS);
}

export function decideCarryOver({summary, head, headDiffId, receipts}) {
  if (!summary) return {ok: false, reason: 'no Greptile summary'};
  if (summary.score !== 5) return {ok: false, reason: `Greptile score is ${summary.score}/5`};
  if (summary.reviewed === head) return {ok: true, reason: 'review names the current head'};
  const receipt = receipts.find(entry => entry.reviewed === summary.reviewed);
  if (!receipt) return {ok: false, reason: 'no fingerprint recorded for the reviewed commit'};
  if (receipt.diffId !== headDiffId) return {ok: false, reason: 'PR diff changed since the review'};
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

function fetchRefs(git, pr, baseRefName, extra = []) {
  git(['fetch', '--quiet', '--no-tags', 'origin',
    `+refs/heads/${baseRefName}:refs/remotes/origin/${baseRefName}`,
    `+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`,
    ...extra]);
}

function record(repo, pr, git) {
  const {view, comments} = loadPull(repo, pr);
  const summary = parseGreptileSummary(comments);
  if (!summary) {
    console.log(JSON.stringify({pr: Number(pr), recorded: false, reason: 'no Greptile summary'}));
    return 0;
  }
  // The reviewed commit is usually the PR head; an older one is fetched by SHA.
  fetchRefs(git, pr, view.baseRefName, summary.reviewed === view.headRefOid ? [] : [summary.reviewed]);
  const base = forkPoint(git, summary.reviewed, [view.baseRefOid, `origin/${view.baseRefName}`]);
  const receipt = {reviewed: summary.reviewed, base, diffId: prOwnDiffId(git, summary.reviewed, base), recordedAt: new Date().toISOString()};
  const existing = readReceipts(comments);
  const body = JSON.stringify({body: renderReceipts(upsertReceipt(existing.receipts, receipt))});
  const endpoint = existing.commentId ? `repos/${repo}/issues/comments/${existing.commentId}` : `repos/${repo}/issues/${pr}/comments`;
  gh(['api', '--method', existing.commentId ? 'PATCH' : 'POST', endpoint, '--input', '-'], body);
  console.log(JSON.stringify({pr: Number(pr), recorded: true, score: summary.score, ...receipt}));
  return 0;
}

function check(repo, pr, git) {
  const {view, comments} = loadPull(repo, pr);
  const summary = parseGreptileSummary(comments);
  const {receipts} = readReceipts(comments);
  let headDiffId = null;
  if (summary && summary.reviewed !== view.headRefOid) {
    fetchRefs(git, pr, view.baseRefName);
    const base = forkPoint(git, view.headRefOid, [view.baseRefOid, `origin/${view.baseRefName}`]);
    headDiffId = prOwnDiffId(git, view.headRefOid, base);
  }
  const result = decideCarryOver({summary, head: view.headRefOid, headDiffId, receipts});
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
