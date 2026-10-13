#!/usr/bin/env node
// Decide whether a PR's Greptile review still covers its current head.
// A review carries over only when everything after the reviewed commit merely
// integrates the base branch: no new PR-authored commits, and the PR's own diff
// against its base is identical. Conflict resolutions change that diff and
// therefore still require a fresh review.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const SHA = /^[0-9a-f]{40}$/;
const MAX_BUFFER = 256 * 1024 * 1024;

export function gitRunner(cwd) {
  return args => execFileSync('git', args, {cwd, encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 60_000});
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

// Zero-context diff without hunk positions or blob ids: main moving or editing
// lines around the PR's changes keeps the id, while any change to what the PR
// adds or removes alters it. Binary hunks keep their full content.
export function prOwnDiffId(git, sha, baseRef) {
  const base = git(['merge-base', baseRef, sha]).trim();
  const diff = git(['diff', '--binary', '--full-index', '-U0', '--no-color', base, sha]);
  const normalized = diff.replace(/^@@ [^@]* @@.*$/gm, '@@').replace(/^index [0-9a-f]+\.\.[0-9a-f]+.*$/gm, 'index');
  return createHash('sha256').update(normalized).digest('hex');
}

export function reviewCarriesOver(git, {reviewed, head, baseRef}) {
  if (!SHA.test(reviewed) || !SHA.test(head)) return {carry: false, reason: 'missing reviewed or head commit'};
  if (reviewed === head) return {carry: true, reason: 'review names the current head'};
  if (!isAncestor(git, reviewed, head)) return {carry: false, reason: 'reviewed commit is not an ancestor of the head'};
  const authored = git(['rev-list', '--no-merges', head, `^${reviewed}`, `^${baseRef}`]).trim();
  if (authored) return {carry: false, reason: 'PR-authored commits were added after the review'};
  if (prOwnDiffId(git, reviewed, baseRef) !== prOwnDiffId(git, head, baseRef)) {
    return {carry: false, reason: 'PR diff changed while integrating the base'};
  }
  return {carry: true, reason: 'head only integrates the base; PR diff is unchanged'};
}

function gh(args) {
  return execFileSync('gh', args, {encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 60_000});
}

async function main() {
  const pr = process.argv[2];
  if (!/^[1-9][0-9]{0,6}$/.test(pr || '')) {
    console.error('usage: node scripts/review/review-carryover.mjs <pr-number>');
    process.exit(2);
  }
  const repo = process.env.GITHUB_REPOSITORY || 'HamedMP/matrix-os';
  const view = JSON.parse(gh(['pr', 'view', pr, '--repo', repo, '--json', 'headRefOid,headRefName,baseRefName']));
  const comments = JSON.parse(gh(['api', `repos/${repo}/issues/${pr}/comments`, '--paginate', '--slurp']));
  const summary = comments.flat().filter(comment => comment.user?.login === 'greptile-apps[bot]' && /Confidence Score:/.test(comment.body || '')).at(-1)?.body || '';
  const score = summary.match(/Confidence Score: ([0-9])\/5/)?.[1] ?? null;
  const reviewed = summary.match(/commit\/([0-9a-f]{40})/)?.[1] ?? '';
  const git = gitRunner(process.cwd());
  git(['fetch', '--quiet', 'origin', view.baseRefName, view.headRefName]);
  const result = reviewCarriesOver(git, {reviewed, head: view.headRefOid, baseRef: `origin/${view.baseRefName}`});
  const ok = score === '5' && result.carry;
  console.log(JSON.stringify({pr: Number(pr), score: score && `${score}/5`, reviewed, head: view.headRefOid, ...result, ok}));
  process.exit(ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) await main();
