import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createConditionalGithub} from '../../scripts/ci/dedicated-api.mjs';
import {waitForDedicatedResult} from '../../scripts/ci/dedicated-result.mjs';

const url = 'https://api.github.com/repos/HamedMP/matrix-os/actions/workflows/ci-dedicated.yml';
const response = (data: unknown, etag = '"fresh"') => ({status: 200, url, headers: {etag}, data});
function limited(status = 403, headers: Record<string, string> = {}) {
  return Object.assign(new Error('GitHub rate limit'), {status, response: {status, url, headers: {
    ...(status === 403 ? {'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1)} : {'retry-after': '1'}), ...headers,
  }}});
}
function adapter(methods: Record<string, ReturnType<typeof vi.fn>>, remaining = () => 10_000) {
  const aborter = new AbortController();
  return {aborter, ...createConditionalGithub({rest: {actions: methods}}, {
    authenticationContext: 'requester-42-1', signal: aborter.signal,
    waiterBackoff: {remainingMilliseconds: remaining},
  })};
}
// Attach rejection observers immediately, including on the original failing code.
const outcome = <T>(p: Promise<T>): Promise<{value?: T; error?: unknown}> => p.then(value => ({value}), error => ({error}));
beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-16T13:20:21.000Z'));});
afterEach(() => vi.useRealTimers());

it.each([403, 429])('waits for an explicit %i reset then makes a fresh authenticated read', async status => {
  const read = vi.fn().mockRejectedValueOnce(limited(status)).mockResolvedValue(response({fresh: true}));
  const api = adapter({getWorkflow: read}); const pending = outcome(api.github.rest.actions.getWorkflow({workflow_id: 'ci-dedicated.yml'}));
  await vi.advanceTimersByTimeAsync(999); expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual({value: response({fresh: true})});
  expect(read).toHaveBeenCalledTimes(2);
  expect(api.metrics()).toMatchObject({rateLimitRetries: 1, rateLimitWaitMilliseconds: 1000});
});

it('honors a canonical future HTTP-date Retry-After', async () => {
  const read = vi.fn().mockRejectedValueOnce(limited(429, {'retry-after': new Date(Date.now() + 1000).toUTCString()})).mockResolvedValue(response({fresh: true}));
  const api = adapter({getWorkflow: read}); const pending = outcome(api.github.rest.actions.getWorkflow({}));
  await vi.advanceTimersByTimeAsync(1000); expect(await pending).toEqual({value: response({fresh: true})}); expect(read).toHaveBeenCalledTimes(2);
});

it.each(['foreign-origin', 'contradictory-status'])('does not trust rate metadata with %s', async kind => {
  const error = limited(); if (kind === 'foreign-origin') error.response.url = 'https://unexpected.invalid/'; else error.response.status = 429;
  const read = vi.fn().mockRejectedValue(error); const api = adapter({getWorkflow: read});
  expect((await outcome(api.github.rest.actions.getWorkflow({}))).error).toBe(error);
  await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1);
});

it('discards a cached representation after rate exhaustion instead of awarding stale coverage', async () => {
  const read = vi.fn().mockResolvedValueOnce(response({revision: 'old'}, '"old"')).mockRejectedValueOnce(limited()).mockResolvedValueOnce(response({revision: 'new'}));
  const api = adapter({getWorkflow: read}); await api.github.rest.actions.getWorkflow({workflow_id: 'ci-dedicated.yml'});
  const pending = outcome(api.github.rest.actions.getWorkflow({workflow_id: 'ci-dedicated.yml'}));
  await vi.advanceTimersByTimeAsync(1000); expect(await pending).toEqual({value: response({revision: 'new'})});
  expect(read.mock.calls[1][0].headers['if-none-match']).toBe('"old"');
  expect(read.mock.calls[2][0].headers?.['if-none-match']).toBeUndefined();
});

it('bounds the whole waiter to three retries across different read endpoints', async () => {
  let reads = 0;
  const first = vi.fn(async () => {if (++reads <= 2) throw limited(); return response({id: 9});});
  const second = vi.fn(async () => {throw limited();}); const api = adapter({getWorkflow: first, getWorkflowRun: second});
  const one = outcome(api.github.rest.actions.getWorkflow({})); await vi.advanceTimersByTimeAsync(2000);
  expect(await one).toEqual({value: response({id: 9})});
  const two = outcome(api.github.rest.actions.getWorkflowRun({})); await vi.advanceTimersByTimeAsync(1000);
  expect((await two).error).toMatchObject({status: 403});
  expect(first).toHaveBeenCalledTimes(3); expect(second).toHaveBeenCalledTimes(2);
  expect(api.metrics()).toMatchObject({rateLimitRetries: 3});
});

it('aborts a reset pause without another request', async () => {
  const read = vi.fn(async () => {throw limited();}); const api = adapter({getWorkflow: read});
  const pending = outcome(api.github.rest.actions.getWorkflow({})); await vi.advanceTimersByTimeAsync(100); api.aborter.abort();
  await vi.advanceTimersByTimeAsync(5000); expect((await pending).error).toBeInstanceOf(Error);
  expect(read).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
});

it('rechecks the remaining waiter budget after a pause before another request', async () => {
  let remaining = 2000; const read = vi.fn(async () => {throw limited();}); const api = adapter({getWorkflow: read}, () => remaining);
  const pending = outcome(api.github.rest.actions.getWorkflow({})); await vi.advanceTimersByTimeAsync(100); remaining = 0;
  await vi.advanceTimersByTimeAsync(1000); expect((await pending).error).toMatchObject({status: 403}); expect(read).toHaveBeenCalledTimes(1);
});

it.each([
  [401, {}], [403, {'x-ratelimit-remaining': '1'}], [403, {'x-ratelimit-reset': ''}],
  [403, {'x-ratelimit-reset': 'NaN'}], [403, {'x-ratelimit-reset': '0'}],
  [429, {'retry-after': ''}], [429, {'retry-after': 'NaN'}], [429, {'retry-after': '121'}],
] as [number, Record<string, string>][] )('does not retry an unqualified error %i %j', async (status, headers) => {
  const error = limited(status, headers), read = vi.fn().mockRejectedValue(error); const api = adapter({getWorkflow: read});
  expect((await outcome(api.github.rest.actions.getWorkflow({}))).error).toBe(error);
  await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1);
});

it('refuses a reset beyond the existing deadline or the 120-second pause cap', async () => {
  for (const seconds of [2, 121]) {
    const read = vi.fn().mockRejectedValue(limited(429, {'retry-after': String(seconds)})); const api = adapter({getWorkflow: read}, () => 1500);
    expect((await outcome(api.github.rest.actions.getWorkflow({}))).error).toBeInstanceOf(Error); expect(read).toHaveBeenCalledTimes(1);
  }
});

it('does not opt controller reads or mutation methods into backoff', async () => {
  const error = limited(), read = vi.fn().mockRejectedValue(error), write = vi.fn().mockRejectedValue(error);
  const controller = createConditionalGithub({rest: {actions: {getWorkflow: read}}}, {authenticationContext: 'controller-42-1'});
  expect((await outcome(controller.github.rest.actions.getWorkflow({}))).error).toBe(error);
  const waiter = adapter({createWorkflowDispatch: write}); expect((await outcome(waiter.github.rest.actions.createWorkflowDispatch({}))).error).toBe(error);
  await vi.advanceTimersByTimeAsync(5000); expect(read).toHaveBeenCalledTimes(1); expect(write).toHaveBeenCalledTimes(1);
});

it('opts the actual result waiter in and still rejects a moved main after API recovery', async () => {
  const moved = new Error('Current main source is stale');
  const getWorkflow = vi.fn().mockRejectedValueOnce(limited()).mockResolvedValue(response({id: 9, path: '.github/workflows/ci-dedicated.yml'}));
  const getBranch = vi.fn().mockRejectedValue(moved); const github = {rest: {actions: {getWorkflow}, repos: {getBranch}}};
  const source = 'a'.repeat(40), expected = {sourceKind: 'main', prNumber: 0, owner: 'HamedMP', repo: 'matrix-os', requestingRunId: 42, requestingRunAttempt: 1,
    imageDigest: 'sha256:' + 'e'.repeat(64), harnessDigest: 'f'.repeat(64), mode: 'delegated', headSha: source, sourceSha: source,
    baseSha: 'b'.repeat(40), headRef: 'main', baseRef: 'main', mergeParents: ['b'.repeat(40)], serverUrl: 'https://github.com'};
  const pending = outcome(waitForDedicatedResult(github, expected, {maxMilliseconds: 5000, maxAttempts: 1}));
  await vi.advanceTimersByTimeAsync(1000); expect((await pending).error).toBe(moved);
  expect(getWorkflow).toHaveBeenCalledTimes(2); expect(getBranch).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
});
