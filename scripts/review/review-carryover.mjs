#!/usr/bin/env node
// Decide whether a PR's Greptile review still covers its current head.
//
// `record <pr>` runs from .github/workflows/review-receipt.yml whenever
// Greptile edits its summary. It stores the base each reviewed commit forked
// from in a PR comment. The base has to be captured then: a stack restack
// force-pushes the parent, after which the reviewed commit's old base is no
// longer on any branch.
//
// `check <pr>` passes a 5/5 review when it names the head, or when both hold:
// the head's tree is exactly git's clean replay of the reviewed change onto
// the head's current base (a three-way merge from the recorded base), and the
// PR's own diff with three context lines is unchanged. Restacks, retargets
// after a parent lands, base merges, and message-only amends pass. New work,
// moved edits, conflict resolutions, and base edits within three lines of the
// PR's changes fail and need a fresh review. A receipt only names commits;
// check recomputes everything from git objects.
//
// Exit codes: 0 the review carries over, 1 a fresh review is needed,
// 2 usage, 3 could not decide (GitHub or git access failed; fix and rerun).
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 256 * 1024 * 1024;
export const GREPTILE_LOGIN = 'greptile-apps[bot]';
export const RECEIPT_LOGIN = 'github-actions[bot]';
export const RECEIPT_MARKER = '<!-- matrix-review-receipt v1 -->';
export const MAX_RECEIPTS = 30;

// GitHub or git transport failed, so the answer is unknown rather than "no".
export class AccessError extends Error {}

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

// rev-parse exits 1 for a name or object this clone does not have.
function resolveCommit(git, name) {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]).trim();
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

// merge-base exits 1 for unrelated histories. A criss-cross history has
// several best bases, so no single fork point exists.
function uniqueMergeBase(git, a, b) {
  try {
    const bases = git(['merge-base', '--all', a, b]).trim().split('\n').filter(Boolean);
    return bases.length === 1 ? bases[0] : null;
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

// The PR head forked from whichever base candidate sits closest to it: the
// recorded PR base SHA can lag the live branch, and either may be missing.
// Candidates that disagree without one containing the other fail closed.
export function forkPoint(git, sha, candidates) {
  const tips = [...new Set(candidates.map(candidate => resolveCommit(git, candidate)).filter(Boolean))];
  const bases = [...new Set(tips.map(tip => uniqueMergeBase(git, tip, sha)).filter(Boolean))];
  if (bases.length === 0) throw new Error('No usable base for the PR head');
  const closest = bases.length === 1 ? bases[0] : bases.find(base => bases.every(other => isAncestor(git, other, base)));
  if (!closest) throw new Error('Ambiguous base for the PR head');
  return closest;
}

export function treeOf(git, sha) {
  return git(['rev-parse', '--verify', `${sha}^{tree}`]).trim();
}

// The tree git produces by replaying base..reviewed onto newBase, or null when
// that replay conflicts. merge-tree exits 1 for conflicts and >1 for errors.
export function replayTree(git, reviewed, base, newBase) {
  try {
    return git(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, newBase, reviewed]).split('\n')[0].trim();
  } catch (error) {
    if (error?.status === 1) return null;
    throw error;
  }
}

// The PR's own diff with three context lines, line numbers and blob ids
// stripped: base edits away from the PR keep it, while a base edit next to a
// PR change (such as a removed guard above an insertion) alters it even when
// git would merge it cleanly. Every setting that changes diff output is pinned.
export function contextDiffId(git, sha, base) {
  const diff = git([
    '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false',
    'diff', '--binary', '--full-index', '--unified=3', '--inter-hunk-context=0', '--indent-heuristic',
    '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames', '--diff-algorithm=myers',
    '--src-prefix=a/', '--dst-prefix=b/', '--no-relative', '-O/dev/null',
    base, sha,
  ]);
  const normalized = diff.replace(/^@@ [^@]* @@.*$/gm, '@@').replace(/^index [0-9a-f]+\.\.[0-9a-f]+/gm, 'index');
  return createHash('sha256').update(normalized).digest('hex');
}

const singleMatch = (body, pattern) => {
  const values = [...new Set([...body.matchAll(pattern)].map(match => match.slice(1).join('\n')))];
  return values.length === 1 ? values[0] : null;
};

// Read only Greptile's own score heading and its footer link target. Prose or
// commit titles quoting either produce a second match, which fails closed.
export function parseGreptileSummary(comments, repo) {
  const summary = comments.filter(comment => comment.user?.login === GREPTILE_LOGIN && /Confidence Score:/.test(comment.body || '')).at(-1);
  if (!summary) return null;
  const score = singleMatch(summary.body, /Confidence Score: ([0-5])\/5<\/h[1-6]>/g);
  const footer = singleMatch(summary.body, /^<sub>.*Last reviewed commit: \[.*\]\(https:\/\/github\.com\/([^/\s()]+\/[^/\s()]+)\/commit\/([0-9a-f]{40})\) · \[Reviewed by Greptile\].*$/gm);
  if (score === null || footer === null || (summary.body.match(/Last reviewed commit:/g) || []).length !== 1) return null;
  const [linkedRepo, reviewed] = footer.split('\n');
  if (repo && linkedRepo.toLowerCase() !== repo.toLowerCase()) return null;
  return {commentId: summary.id, score: Number(score), reviewed};
}

const validReceipt = value => value && SHA.test(value.reviewed) && SHA.test(value.base) && typeof value.recordedAt === 'string';

// Fork PRs cannot post as the workflow token. Repository writers can, but they
// can also merge without Greptile, and check recomputes every tree anyway.
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
    'Greptile review base receipts for `scripts/review/review-carryover.mjs`. Maintained by the Review Receipt workflow; do not edit.',
    `<!-- receipts ${JSON.stringify({v: 1, receipts})} -->`,
  ].join('\n');
}

// The first receipt for a reviewed commit wins: it was taken closest to the
// review, before a later restack could move the base out from under it.
export function addReceipt(receipts, receipt) {
  if (receipts.some(entry => entry.reviewed === receipt.reviewed)) return receipts;
  return [...receipts, receipt].slice(-MAX_RECEIPTS);
}

// `trees(receipt)` is only called once score and receipt allow a carry. It
// returns the replayed tree (null on conflict), the head tree, and the
// reviewed and head context diff ids.
export function decideCarryOver({summary, head, receipts, trees}) {
  if (!summary) return {ok: false, reason: 'no trusted Greptile summary'};
  if (summary.score !== 5) return {ok: false, reason: `Greptile score is ${summary.score}/5`};
  if (summary.reviewed === head) return {ok: true, reason: 'review names the current head'};
  const receipt = receipts.find(entry => entry.reviewed === summary.reviewed);
  if (!receipt) return {ok: false, reason: 'no base recorded for the reviewed commit'};
  const {replayed, head: headTree, reviewedContext, headContext} = trees(receipt);
  if (replayed === null) return {ok: false, reason: 'reviewed change no longer replays cleanly onto the new base'};
  if (replayed !== headTree) return {ok: false, reason: 'head differs from the reviewed change replayed onto its base'};
  if (reviewedContext !== headContext) return {ok: false, reason: 'base changed code next to the reviewed change'};
  return {ok: true, reason: 'head is the reviewed change replayed onto its new base'};
}

function access(run, what) {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    throw new AccessError(`${what} failed: ${error.message.split('\n')[0]}`);
  }
}

function gh(args, input) {
  return access(() => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 60_000, ...(input ? {input} : {})}), `gh ${args[0]}`);
}

function loadPull(repo, pr) {
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,baseRefName,baseRefOid']));
  const comments = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp'])).flat();
  return {view, comments};
}

// Commits are fetched by SHA so a lagging refs/pull/<n>/head or a force-pushed
// commit still resolves; GitHub serves unreachable PR commits by SHA.
function fetchRefs(git, pr, baseRefName, shas = []) {
  access(() => git(['fetch', '--quiet', '--no-tags', 'origin',
    `+refs/heads/${baseRefName}:refs/remotes/origin/${baseRefName}`,
    `+refs/pull/${pr}/head:refs/remotes/origin/pr/${pr}`,
    ...new Set(shas)]), 'git fetch');
}

// `view` is the PR's headRefOid/baseRefName/baseRefOid as GitHub reports them.
export function receiptFor(git, pr, view, reviewed, now = new Date()) {
  fetchRefs(git, pr, view.baseRefName, [reviewed]);
  const base = forkPoint(git, reviewed, [view.baseRefOid, `origin/${view.baseRefName}`]);
  return {reviewed, base, recordedAt: now.toISOString()};
}

export function pullTrees(git, pr, view, receipt) {
  fetchRefs(git, pr, view.baseRefName, [receipt.reviewed, receipt.base, view.headRefOid]);
  if (!isAncestor(git, receipt.base, receipt.reviewed)) throw new Error('Recorded base is not an ancestor of the reviewed commit');
  const newBase = forkPoint(git, view.headRefOid, [view.baseRefOid, `origin/${view.baseRefName}`]);
  return {
    replayed: replayTree(git, receipt.reviewed, receipt.base, newBase),
    head: treeOf(git, view.headRefOid),
    reviewedContext: contextDiffId(git, receipt.reviewed, receipt.base),
    headContext: contextDiffId(git, view.headRefOid, newBase),
  };
}

function record(repo, pr, git) {
  const {view, comments} = loadPull(repo, pr);
  const summary = parseGreptileSummary(comments, repo);
  if (!summary) {
    console.log(JSON.stringify({pr: Number(pr), recorded: false, reason: 'no trusted Greptile summary'}));
    return 0;
  }
  const existing = readReceipts(comments);
  if (existing.receipts.some(entry => entry.reviewed === summary.reviewed)) {
    console.log(JSON.stringify({pr: Number(pr), recorded: false, reason: 'base already recorded', reviewed: summary.reviewed}));
    return 0;
  }
  let receipt;
  try {
    receipt = receiptFor(git, pr, view, summary.reviewed);
  } catch (error) {
    if (error instanceof AccessError || !(error instanceof Error)) throw error;
    // No single base: carry-over fails closed for this review, which is safe.
    console.warn(`review-carryover: not recording PR ${pr} @ ${summary.reviewed}: ${error.message.split('\n')[0]}`);
    return 0;
  }
  const body = JSON.stringify({body: renderReceipts(addReceipt(existing.receipts, receipt))});
  const endpoint = existing.commentId ? `repos/${repo}/issues/comments/${existing.commentId}` : `repos/${repo}/issues/${pr}/comments`;
  gh(['api', '--method', existing.commentId ? 'PATCH' : 'POST', endpoint, '--input', '-'], body);
  console.log(JSON.stringify({pr: Number(pr), recorded: true, score: summary.score, ...receipt}));
  return 0;
}

function check(repo, pr, git) {
  const {view, comments} = loadPull(repo, pr);
  const summary = parseGreptileSummary(comments, repo);
  const {receipts} = readReceipts(comments);
  let result;
  try {
    result = decideCarryOver({summary, head: view.headRefOid, receipts, trees: receipt => pullTrees(git, pr, view, receipt)});
  } catch (error) {
    if (error instanceof AccessError || !(error instanceof Error)) throw error;
    console.error(`review-carryover: cannot replay PR ${pr}: ${error.message.split('\n')[0]}`);
    result = {ok: false, reason: 'reviewed change cannot be replayed onto the head base'};
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
  try {
    return command === 'record' ? record(repo, pr, git) : check(repo, pr, git);
  } catch (error) {
    if (!(error instanceof AccessError)) throw error;
    console.error(`review-carryover: could not decide: ${error.message}`);
    return 3;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main());
