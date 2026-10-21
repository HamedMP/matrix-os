#!/usr/bin/env node
// Advisory only: status rollups cannot prove test coverage or authorize a merge.
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHA = /^[a-f0-9]{40}$/;
const MAX_PAGES = 20;
const MANUAL_GATES = [
  'authenticated exact-source full qualification evidence',
  'finding dispositions and applicable live surface evidence',
  'verified ENG ticket, native stack membership and merge authorization',
];

export function assessReadiness({ pull, review, threads, reviews, checks }) {
  const blockers = [];
  if (pull.state !== 'OPEN') blockers.push(`PR state is ${pull.state}`);
  if (pull.isDraft) blockers.push('PR is draft');
  if (!review.ok || review.head !== pull.headRefOid) blockers.push('Greptile review is not valid for this head');
  const unresolved = threads.filter(thread => !thread.isResolved);
  if (unresolved.length) blockers.push(`${unresolved.length} unresolved review thread(s)`);

  // The API returns chronological reviews. Comments do not revoke an approval,
  // but later change requests/dismissals do. Bound by collection's page limit.
  const latest = new Map();
  for (const entry of reviews) {
    if (entry.author?.__typename !== 'User' || entry.author.login === pull.author.login) continue;
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(entry.state)) latest.set(entry.author.login, entry);
  }
  const approved = [...latest.values()].some(entry => entry.state === 'APPROVED' && entry.commit?.oid === pull.headRefOid);
  if (pull.reviewDecision !== 'APPROVED' || !approved) blockers.push('no current-head independent human approval');
  if (pull.mergeable !== 'MERGEABLE') blockers.push(`mergeability is ${pull.mergeable}`);
  const ticketReferences = [...new Set(pull.body.match(/\bENG-[1-9][0-9]*\b/g) ?? [])];
  if (!ticketReferences.length) blockers.push('missing ENG ticket reference');
  if (!checks.length) blockers.push('required checks are unavailable or empty');
  else if (checks.some(check => check.bucket !== 'pass' || check.state !== 'SUCCESS')) blockers.push('required checks have not all passed');

  const nextActions = [];
  if (!review.ok || review.head !== pull.headRefOid) nextActions.push('inspect review reason; follow bounded review request policy');
  if (pull.isDraft && review.ok && review.head === pull.headRefOid && !unresolved.length) {
    nextActions.push('if publication is authorized, mark ready once to admit full CI');
  }
  if (unresolved.length) nextActions.push('address or explicitly disposition findings and resolve their threads');
  if (!approved || pull.reviewDecision !== 'APPROVED') nextActions.push('obtain current-head independent human approval');
  nextActions.push('verify genuine qualification artifacts and remaining manual gates; rerun this report before merge');
  return {
    schemaVersion: 1, advisory: true, repositoryPolicy: 'AGENTS.md',
    number: pull.number, url: pull.url, head: pull.headRefOid, base: pull.baseRefOid,
    target: pull.baseRefName, draft: pull.isDraft, ticketReferences,
    review, unresolvedThreads: unresolved, independentApproval: approved,
    requiredChecks: checks, qualificationVerified: false,
    decision: blockers.length ? 'blocked' : 'verify-evidence', blockers,
    manualGates: MANUAL_GATES, nextActions,
  };
}

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8', timeout: command === process.execPath ? 120_000 : 30_000,
    maxBuffer: 4 * 1024 * 1024, ...options,
  });
  if (result.error) throw new Error('readiness command could not complete', { cause: result.error });
  return result;
}

function decode(result, allowed = [0]) {
  if (!allowed.includes(result.status)) throw new Error('readiness data is unavailable');
  try { return JSON.parse(result.stdout); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('malformed readiness response', { cause: error });
  }
}

function validatePull(pull, number) {
  if (!pull || pull.number !== Number(number) || !SHA.test(pull.headRefOid ?? '') || !SHA.test(pull.baseRefOid ?? '') ||
      typeof pull.isDraft !== 'boolean' || typeof pull.body !== 'string' || typeof pull.author?.login !== 'string' ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(pull.state) || typeof pull.baseRefName !== 'string' || typeof pull.url !== 'string') {
    throw new Error('malformed PR snapshot');
  }
}

function sameSource(pull, current) {
  if (current?.headRefOid !== pull.headRefOid || current?.baseRefOid !== pull.baseRefOid) {
    throw new Error('PR head or base changed during readiness collection; collect again');
  }
}

function connection(value, name) {
  if (!value || !Array.isArray(value.nodes) || value.nodes.length > 100 ||
      typeof value.pageInfo?.hasNextPage !== 'boolean' ||
      (value.pageInfo.hasNextPage && (typeof value.pageInfo.endCursor !== 'string' || !value.pageInfo.endCursor))) {
    throw new Error(`malformed ${name} pagination`);
  }
  return value;
}

const QUERY = `query($owner:String!,$repo:String!,$number:Int!,$threadsAfter:String,$reviewsAfter:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$number){headRefOid baseRefOid
    reviewThreads(first:100,after:$threadsAfter){nodes{id isResolved} pageInfo{hasNextPage endCursor}}
    reviews(first:100,after:$reviewsAfter){nodes{author{login __typename} state commit{oid}} pageInfo{hasNextPage endCursor}}
  }}
}`;

export function collectReadiness(number, { run = execute, repository = 'HamedMP/matrix-os' } = {}) {
  if (!/^[1-9][0-9]{0,6}$/.test(number) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('invalid PR or repository');
  const fields = 'number,state,isDraft,headRefOid,baseRefOid,baseRefName,url,author,reviewDecision,mergeable,body';
  const view = () => decode(run('gh', ['pr', 'view', number, '--repo', repository, '--json', fields]));
  const pull = view();
  validatePull(pull, number);
  const [owner, repo] = repository.split('/');
  const threads = [], reviews = [];
  let threadsAfter, reviewsAfter, threadsDone = false, reviewsDone = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${number}`];
    if (threadsAfter) args.push('-f', `threadsAfter=${threadsAfter}`);
    if (reviewsAfter) args.push('-f', `reviewsAfter=${reviewsAfter}`);
    const response = decode(run('gh', args));
    if (response.errors) throw new Error('review API returned errors');
    const current = response.data?.repository?.pullRequest;
    sameSource(pull, current);
    const tc = connection(current.reviewThreads, 'threads');
    const rc = connection(current.reviews, 'reviews');
    if (!threadsDone) threads.push(...tc.nodes);
    if (!reviewsDone) reviews.push(...rc.nodes);
    if (!threadsDone) {
      if (tc.pageInfo.hasNextPage && tc.pageInfo.endCursor === threadsAfter) throw new Error('threads pagination did not advance');
      threadsDone = !tc.pageInfo.hasNextPage;
      threadsAfter = tc.pageInfo.endCursor;
    }
    if (!reviewsDone) {
      if (rc.pageInfo.hasNextPage && rc.pageInfo.endCursor === reviewsAfter) throw new Error('reviews pagination did not advance');
      reviewsDone = !rc.pageInfo.hasNextPage;
      reviewsAfter = rc.pageInfo.endCursor;
    }
    if (threadsDone && reviewsDone) break;
    if (page === MAX_PAGES - 1) throw new Error('review pagination exceeds safe collection limit');
  }
  if (threads.some(entry => typeof entry?.id !== 'string' || typeof entry.isResolved !== 'boolean') ||
      reviews.some(entry => !entry || typeof entry.state !== 'string' || (entry.commit !== null && !SHA.test(entry.commit?.oid ?? '')))) {
    throw new Error('malformed review data');
  }
  const checkResult = run('gh', ['pr', 'checks', number, '--repo', repository, '--required', '--json', 'name,state,bucket,link']);
  // gh emits no JSON for an empty required-check set on draft PRs. Distinguish
  // that observed CLI response from access errors, which remain unknown.
  const noChecks = checkResult.status === 1 && !checkResult.stdout.trim() &&
    /^no required checks reported on the '[^\r\n]+' branch\s*$/.test(checkResult.stderr ?? '');
  const checks = noChecks ? [] : decode(checkResult, [0, 1, 8]);
  if (!Array.isArray(checks) || checks.length > 1000 || checks.some(check =>
    !check || ['name', 'state', 'bucket', 'link'].some(key => typeof check[key] !== 'string'))) throw new Error('malformed required checks');
  const helper = fileURLToPath(new URL('./review-carryover.mjs', import.meta.url));
  const review = decode(run(process.execPath, [helper, 'check', number], { env: { ...process.env, GITHUB_REPOSITORY: repository } }), [0, 1]);
  if (typeof review?.ok !== 'boolean' || !SHA.test(review.head ?? '')) throw new Error('review verifier could not decide');
  const final = view();
  validatePull(final, number);
  sameSource(pull, final);
  // Use the latest draft/review rollup, not one sampled before API collection.
  return { ...assessReadiness({ pull: final, review, threads, reviews, checks }), repository };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/review/pr-readiness.mjs <pr-number>');
    const report = collectReadiness(process.argv[2]);
    console.log(JSON.stringify(report, null, 2));
    // Exit 0 means collection succeeded with no machine-visible blockers;
    // it NEVER means permission or sufficient evidence to merge.
    process.exitCode = report.blockers.length ? 1 : 0;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(`pr-readiness: could not decide: ${error.message}`);
    process.exitCode = 3;
  }
}
