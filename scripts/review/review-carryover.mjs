#!/usr/bin/env node
// Decide whether a PR's Greptile review still covers its current head.
//
// `record <pr>` runs from .github/workflows/review-receipt.yml on Greptile
// summary edits that introduce a review (the review count rises or the
// reviewed commit changes) while that commit is still the PR head. It stores
// the base the reviewed commit forked from in a PR comment. The base has to be
// captured then: a stack restack force-pushes the parent, after which the
// reviewed commit's old base is no longer on any branch.
//
// `check <pr>` passes a 5/5 review when both hold: the head's tree is exactly
// git's clean replay of the reviewed change onto the head's current base (a
// three-way merge from the recorded base), and the PR's own diff with three
// context lines is unchanged. Restacks, retargets after a parent lands, base
// merges, and message-only amends pass. New work, moved edits, conflict
// resolutions, base edits within three lines of the PR's changes, and a
// retarget that pulls parent commits into the PR fail and need a fresh review.
// A receipt only names commits; check recomputes everything from git objects.
// Without a receipt, a review that names the head passes as before.
//
// Exit codes: 0 the review carries over, 1 a fresh review is needed,
// 2 usage, 3 could not decide (GitHub, git, or the tool failed; fix and rerun).
import {execFileSync} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 256 * 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// Attributes from the repository under review must not steer merges or diffs.
const NO_ATTRIBUTES = [`--attr-source=${EMPTY_TREE}`, '-c', 'core.attributesFile=/dev/null'];
export const GREPTILE_LOGIN = 'greptile-apps[bot]';
export const RECEIPT_LOGIN = 'github-actions[bot]';
export const RECEIPT_MARKER = '<!-- matrix-review-receipt v1 -->';
export const MAX_RECEIPTS = 30;
// A review plus the record job's queue fit well inside this window.
export const BASE_CHANGE_WINDOW_MS = 30 * 60_000;

// GitHub or git transport failed, so the answer is unknown rather than "no".
export class AccessError extends Error {}
// The data cannot support a carry-over: request a fresh review.
export class FailClosed extends Error {}

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

// merge-base exits 1 for unrelated histories.
function mergeBases(git, a, b) {
  try {
    return git(['merge-base', '--all', a, b]).trim().split('\n').filter(Boolean);
  } catch (error) {
    if (error?.status === 1) return [];
    throw error;
  }
}

// The PR head forked from whichever base candidate sits closest to it: the
// recorded PR base SHA can lag the live branch, and either may be missing
// locally. A present candidate that is unrelated, criss-cross, or disagrees
// with the others without one containing the other fails closed.
export function forkPoint(git, sha, candidates) {
  const tips = [...new Set(candidates.map(candidate => resolveCommit(git, candidate)).filter(Boolean))];
  if (tips.length === 0) throw new FailClosed('No usable base for the PR head');
  const bases = [];
  for (const tip of tips) {
    const found = mergeBases(git, tip, sha);
    if (found.length !== 1) throw new FailClosed('Ambiguous base for the PR head');
    if (!bases.includes(found[0])) bases.push(found[0]);
  }
  const closest = bases.length === 1 ? bases[0] : bases.find(base => bases.every(other => isAncestor(git, other, base)));
  if (!closest) throw new FailClosed('Ambiguous base for the PR head');
  return closest;
}

export function treeOf(git, sha) {
  return git(['rev-parse', '--verify', `${sha}^{tree}`]).trim();
}

// The tree git produces by replaying base..reviewed onto newBase, or null when
// that replay conflicts. merge-tree exits 1 for conflicts and >1 for errors.
export function replayTree(git, reviewed, base, newBase) {
  try {
    return git([...NO_ATTRIBUTES, 'merge-tree', '--write-tree', '--no-messages', `--merge-base=${base}`, newBase, reviewed]).split('\n')[0].trim();
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
    ...NO_ATTRIBUTES, '-c', 'core.quotePath=true', '-c', 'diff.suppressBlankEmpty=false',
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

// Read only Greptile's own score heading and footer link target. Prose or
// commit titles quoting either produce a second match, which fails closed.
// The greedy title match takes the last commit link on the footer line.
export function parseGreptileSummary(comments, repo) {
  const summary = comments.filter(comment => comment.user?.login === GREPTILE_LOGIN && /Confidence Score:/.test(comment.body || '')).at(-1);
  if (!summary) return null;
  const score = singleMatch(summary.body, /Confidence Score: ([0-5])\/5<\/h[1-6]>/g);
  const footer = singleMatch(summary.body, /^<sub>(?:Reviews \((\d+)\) · )?Last reviewed commit: \[.*\]\(https:\/\/github\.com\/([^/\s()]+\/[^/\s()]+)\/commit\/([0-9a-f]{40})\)(?: · \[Reviewed by Greptile\]\([^()\s]*\))?<\/sub>\s*$/gm);
  if (score === null || footer === null || (summary.body.match(/Last reviewed commit:/g) || []).length !== 1) return null;
  const [reviews, linkedRepo, reviewed] = footer.split('\n');
  if (repo && linkedRepo.toLowerCase() !== repo.toLowerCase()) return null;
  return {commentId: summary.id, score: Number(score), reviewed, reviews: reviews ? Number(reviews) : null};
}

// A summary edit introduces a review when Greptile reviewed again (the review
// count rises) or reviewed another commit; footer re-renders do not.
export function introducesReview(event, repo) {
  const current = parseGreptileSummary([event.comment ?? {}], repo);
  if (!current) return null;
  // A created comment has no previous body, so it always introduces a review.
  const previous = parseGreptileSummary([{...event.comment, body: event.changes?.body?.from ?? ''}], repo);
  if (!previous || previous.reviewed !== current.reviewed) return current;
  if (current.reviews !== null && previous.reviews !== null && current.reviews > previous.reviews) return current;
  return null;
}

// A retarget or base force-push while Greptile reviewed or the record job
// queued leaves the reviewed base unknown. Unparseable times count as recent.
export function recentBaseChange(events, now = Date.now(), windowMs = BASE_CHANGE_WINDOW_MS) {
  return events.some(entry => {
    if (entry?.event !== 'base_ref_changed' && entry?.event !== 'base_ref_force_pushed') return false;
    const at = Date.parse(entry.created_at);
    return !Number.isFinite(at) || now - at <= windowMs;
  });
}

const validReceipt = value => value && SHA.test(value.reviewed) && SHA.test(value.base) && Number.isSafeInteger(value.reviews) && value.reviews > 0 && typeof value.recordedAt === 'string';

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

// Receipts are only written when a review happens, so the latest recorded
// review of a commit (for example a re-review after a retarget) defines it.
export function upsertReceipt(receipts, receipt) {
  return [...receipts.filter(entry => entry.reviewed !== receipt.reviewed), receipt].slice(-MAX_RECEIPTS);
}

// `replay(receipt)` returns {replayed, head} trees (replayed is null on
// conflict); `contexts(receipt, replayResult)` returns the reviewed and head
// context ids. Each runs only when the earlier checks allow a carry.
export function decideCarryOver({summary, head, receipts, replay, contexts}) {
  if (!summary) return {ok: false, reason: 'no trusted Greptile summary'};
  if (summary.score !== 5) return {ok: false, reason: `Greptile score is ${summary.score}/5`};
  // A receipt only speaks for the review that produced it. When the latest
  // review went unrecorded (for example during a retarget), the head it names
  // still passes as before, and older heads need a fresh review.
  const receipt = receipts.find(entry => entry.reviewed === summary.reviewed && entry.reviews === summary.reviews);
  if (!receipt) {
    if (summary.reviewed === head) return {ok: true, reason: 'review names the current head'};
    return {ok: false, reason: 'no base recorded for the reviewed commit'};
  }
  const trees = replay(receipt);
  if (trees.replayed === null) return {ok: false, reason: 'reviewed change no longer replays cleanly onto the new base'};
  if (trees.replayed !== trees.head) return {ok: false, reason: 'head differs from the reviewed change replayed onto its base'};
  const ids = contexts(receipt, trees);
  if (ids.reviewed !== ids.head) return {ok: false, reason: 'base changed code next to the reviewed change'};
  return {ok: true, reason: summary.reviewed === head ? 'review names the current head and its base' : 'head is the reviewed change replayed onto its new base'};
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

// One fetch per ref or commit, so a deleted branch or an unserved commit only
// removes that candidate; ls-remote first tells access failures apart. The
// live base lands in a ref unique to this run (refs are shared by every
// worktree and concurrent check), is resolved to a SHA, and is deleted, so a
// failed fetch can never leave another run's or an older tip in play.
// Commits are fetched by SHA so a lagging refs/pull/<n>/head or a force-pushed
// commit still resolves; GitHub serves unreachable PR commits by SHA.
// `optional` commits (GitHub's reported base) are used only when available.
export function fetchPull(git, pr, baseRefName, shas = [], optional = []) {
  access(() => git(['ls-remote', '--exit-code', 'origin', `refs/pull/${pr}/head`]), 'git ls-remote');
  const attempt = refspec => {
    try {
      git(['fetch', '--quiet', '--no-tags', 'origin', refspec]);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.warn(`review-carryover: could not fetch ${refspec}: ${error.message.split('\n')[0]}`);
    }
  };
  const ref = `refs/review-carryover/base-${process.pid}-${randomBytes(8).toString('hex')}`;
  let base = null;
  try {
    attempt(`+refs/heads/${baseRefName}:${ref}`);
    base = resolveCommit(git, ref);
  } finally {
    git(['update-ref', '-d', ref]);
  }
  for (const sha of new Set([...shas, ...optional])) if (SHA.test(sha) && !resolveCommit(git, sha)) attempt(sha);
  for (const sha of new Set(shas)) if (!resolveCommit(git, sha)) throw new FailClosed(`Commit ${sha} is not available`);
  return {base};
}

// A freshly fetched base is what GitHub merges against, so it wins outright;
// GitHub's reported base SHA can lag a reset or force-pushed parent and is
// only a fallback when the branch itself cannot be fetched (e.g. deleted).
const baseCandidates = (view, fetched) => [fetched.base ?? view.baseRefOid].filter(Boolean);

// `view` is the PR's headRefOid/baseRefName/baseRefOid as GitHub reports them;
// `reviews` is the Greptile review count the receipt belongs to.
export function receiptFor(git, pr, view, reviewed, reviews, now = new Date()) {
  const fetched = fetchPull(git, pr, view.baseRefName, [reviewed], [view.baseRefOid]);
  const base = forkPoint(git, reviewed, baseCandidates(view, fetched));
  return {reviewed, base, reviews, recordedAt: now.toISOString()};
}

export function replayPull(git, pr, view, receipt) {
  const fetched = fetchPull(git, pr, view.baseRefName, [receipt.reviewed, receipt.base, view.headRefOid], [view.baseRefOid]);
  if (!isAncestor(git, receipt.base, receipt.reviewed)) throw new FailClosed('Recorded base is not an ancestor of the reviewed commit');
  const newBase = forkPoint(git, view.headRefOid, baseCandidates(view, fetched));
  return {replayed: replayTree(git, receipt.reviewed, receipt.base, newBase), head: treeOf(git, view.headRefOid), newBase};
}

export function pullContexts(git, view, receipt, trees) {
  return {reviewed: contextDiffId(git, receipt.reviewed, receipt.base), head: contextDiffId(git, view.headRefOid, trees.newBase)};
}

function record(repo, pr, git) {
  if (!process.env.GITHUB_EVENT_PATH) {
    console.error('review-carryover: record runs only from the Review Receipt workflow event');
    return 2;
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const summary = introducesReview(event, repo);
  const skip = reason => {
    console.log(JSON.stringify({pr: Number(pr), recorded: false, reason, reviewed: summary?.reviewed ?? null}));
    return 0;
  };
  if (!summary) return skip('summary edit does not introduce a review');
  if (summary.reviews === null) return skip('summary has no review count');
  const {view, comments} = loadPull(repo, pr);
  // Recording after a push, restack, or retarget would pin the wrong base.
  if (view.headRefOid !== summary.reviewed) return skip('PR head moved since the review');
  const timeline = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/timeline?per_page=100`, '--paginate', '--slurp'])).flat();
  if (recentBaseChange(timeline)) return skip('PR base changed during the review window');
  let receipt;
  try {
    receipt = receiptFor(git, pr, view, summary.reviewed, summary.reviews);
  } catch (error) {
    if (!(error instanceof FailClosed)) throw error;
    // No single base: carry-over fails closed for this review, which is safe.
    console.warn(`review-carryover: not recording PR ${pr} @ ${summary.reviewed}: ${error.message}`);
    return skip('no single base');
  }
  const existing = readReceipts(comments);
  const body = JSON.stringify({body: renderReceipts(upsertReceipt(existing.receipts, receipt))});
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
    result = decideCarryOver({
      summary, head: view.headRefOid, receipts,
      replay: receipt => replayPull(git, pr, view, receipt),
      contexts: (receipt, trees) => pullContexts(git, view, receipt, trees),
    });
  } catch (error) {
    if (!(error instanceof FailClosed)) throw error;
    result = {ok: false, reason: error.message};
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
    if (!(error instanceof Error)) throw error;
    console.error(`review-carryover: could not decide: ${error instanceof AccessError ? error.message : error.stack}`);
    return 3;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) process.exit(main());
