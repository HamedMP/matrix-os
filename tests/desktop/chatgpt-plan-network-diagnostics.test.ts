import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requestPlanResponse } from '../../desktop/src/main/chatgpt-plan/responses';
import { logPlanFailure, observePlanFailures, PlanFailure, safePlanFailureRecord, safePlanNetworkDiagnostic } from '../../desktop/src/main/chatgpt-plan/diagnostics';
import { createPlanDiagnosticStore } from '../../desktop/src/main/chatgpt-plan/diagnostic-store';

const secret = 'PRIVATE fixture body/token/url/account detail';
const body = JSON.stringify({ model: 'fixture-model', input: [{ role: 'user', content: 'fictional island 🏝️' }], store: false, stream: true });
const runId = 'run_0123456789abcdef0123456789abcdef';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

it('retains a fetch socket cause and per-request metadata through the failure-only recording seam without private content or retries', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rows: unknown[] = [], unobserve = observePlanFailures(row => rows.push(row));
  let reject!: (error: unknown) => void;
  const fetchFn = vi.fn(() => new Promise<Response>((_, rejectFetch) => { reject = rejectFetch; }));
  try {
    const pending = requestPlanResponse({ fetchFn, body, model: 'fixture-model', signal: new AbortController().signal,
      accessToken: async () => 'PRIVATE fixture access token', validate: () => {} }).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1234);
    reject(Object.assign(new TypeError(secret), { cause: { code: 'UND_ERR_SOCKET', message: secret,
      socket: { remoteAddress: secret }, body: secret, url: secret } }));
    const failure = await pending;
    expect(failure).toBeInstanceOf(PlanFailure);
    expect(failure).toMatchObject({ stage: 'responses', category: 'network_error' });
    logPlanFailure('peer_reply', failure, { runId, accountId: secret, body: secret });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stage: 'responses', category: 'network_error', correlation: { runId },
      networkDiagnostic: { errorName: 'TypeError', causeCode: 'UND_ERR_SOCKET', phase: 'before_headers',
        elapsedMs: 1234, requestBodyBytes: Buffer.byteLength(body) } });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE');
    expect(fetchFn).toHaveBeenCalledOnce();
  } finally { unobserve(); }
});

const networkCodes = [
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
];
it.each(networkCodes)('retains only the fixed transport code %s at both the direct and one-cause seams', async code => {
  const fetchFn = vi.fn(async () => { throw Object.assign(new TypeError(secret), { code, cause: { code, message: secret } }); });
  const failure = await requestPlanResponse({ fetchFn, body, model: 'fixture-model', signal: new AbortController().signal,
    accessToken: async () => 'PRIVATE fixture access token', validate: () => {} }).catch(error => error);
  expect(failure).toBeInstanceOf(PlanFailure);
  expect(failure.networkDiagnostic).toEqual({ errorName: 'TypeError', code, causeCode: code,
    phase: 'before_headers', elapsedMs: expect.any(Number), requestBodyBytes: Buffer.byteLength(body) });
  expect(Number.isInteger(failure.networkDiagnostic.elapsedMs)).toBe(true);
  expect(fetchFn).toHaveBeenCalledOnce();
  expect(JSON.stringify(failure)).not.toContain('PRIVATE');
});

it.each(['Error', 'TypeError', 'RangeError', 'AggregateError', 'DOMException', 'AbortError', 'TimeoutError',
  'SocketError', 'ConnectTimeoutError', 'HeadersTimeoutError', 'BodyTimeoutError'])('allows fixed error name %s without retaining an error instance', errorName => {
  expect(safePlanNetworkDiagnostic({ errorName, message: secret, stack: secret })).toEqual({ errorName });
});

it('does not count credential preparation as fetch waiting time', async () => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout'] });
  let tokenReady!: (token: string) => void;
  const accessToken = () => new Promise<string>(resolve => { tokenReady = resolve; });
  const fetchFn = vi.fn(async () => { throw Object.assign(new Error(secret), { code: 'ECONNRESET' }); });
  const pending = requestPlanResponse({ fetchFn, body, model: 'fixture-model', signal: new AbortController().signal,
    accessToken, validate: () => {} }).catch(error => error);
  await vi.advanceTimersByTimeAsync(5000); expect(fetchFn).not.toHaveBeenCalled();
  tokenReady('PRIVATE fixture access token');
  expect((await pending).networkDiagnostic).toMatchObject({ elapsedMs: 0, code: 'ECONNRESET' });
});

it.each(['timeout', 'cancelled'] as const)('keeps signal %s classification ahead of a transport cause without retrying', async category => {
  const controller = new AbortController();
  const fetchFn = vi.fn(async () => {
    controller.abort(new DOMException(secret, category === 'timeout' ? 'TimeoutError' : 'AbortError'));
    throw Object.assign(new TypeError(secret), { cause: { code: 'UND_ERR_SOCKET' } });
  });
  const failure = await requestPlanResponse({ fetchFn, body, model: 'fixture-model', signal: controller.signal,
    accessToken: async () => 'PRIVATE fixture access token', validate: () => {} }).catch(error => error);
  expect(failure).toMatchObject({ stage: 'responses', category, networkDiagnostic: { phase: 'before_headers', causeCode: 'UND_ERR_SOCKET' } });
  expect(fetchFn).toHaveBeenCalledOnce(); expect(JSON.stringify(failure)).not.toContain('PRIVATE');
});

it('drops unknown names/codes and large nested or cyclic private payloads without walking deeper causes', async () => {
  const large = secret.repeat(100_000);
  const cause: Record<string, unknown> = { code: large, message: large, body: large, url: large,
    cause: { code: 'ECONNRESET', message: large } };
  cause.cycle = cause;
  const fetchFn = vi.fn(async () => { throw { name: large, code: large, cause, account: large, body: large, stack: large }; });
  const failure = await requestPlanResponse({ fetchFn, body, model: 'fixture-model', signal: new AbortController().signal,
    accessToken: async () => 'PRIVATE fixture access token', validate: () => {} }).catch(error => error);
  expect(failure).toMatchObject({ stage: 'responses', category: 'network_error' });
  expect(failure.networkDiagnostic).toEqual({ phase: 'before_headers', elapsedMs: expect.any(Number), requestBodyBytes: Buffer.byteLength(body) });
  expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThan(512);
  expect(JSON.stringify(failure)).not.toContain('PRIVATE');
});

it('does not let hostile diagnostic getters obscure the original transport failure', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = Object.assign(new TypeError(secret), { cause: { code: 'ENOTFOUND' } });
  Object.defineProperty(error, 'code', { get() { throw new Error(secret); } });
  const fetchFn = vi.fn(async () => { throw error; });
  const failure = await requestPlanResponse({ fetchFn, body, model: 'fixture-model', signal: new AbortController().signal,
    accessToken: async () => 'PRIVATE fixture access token', validate: () => {} }).catch(error => error);
  expect(failure).toMatchObject({ stage: 'responses', category: 'network_error',
    networkDiagnostic: { errorName: 'TypeError', causeCode: 'ENOTFOUND', phase: 'before_headers' } });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE'); expect(fetchFn).toHaveBeenCalledOnce();
});

it.each([
  { elapsedMs: -1 }, { elapsedMs: 0.5 }, { elapsedMs: Number.NaN }, { elapsedMs: Infinity }, { elapsedMs: 86400001 }, { elapsedMs: '1' },
  { requestBodyBytes: -1 }, { requestBodyBytes: 0.5 }, { requestBodyBytes: Number.NaN }, { requestBodyBytes: Infinity }, { requestBodyBytes: 512001 }, { requestBodyBytes: '1' },
])('drops out-of-bound/noninteger numeric metadata %j', invalid => {
  expect(safePlanNetworkDiagnostic(invalid)).toEqual({});
});

it('keeps inclusive numeric boundaries while rejecting arbitrary diagnostic keys and strings at console and disk seams', () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const rows: unknown[] = [], unobserve = observePlanFailures(row => rows.push(row));
  try {
    const failure = new PlanFailure('responses', 'network_error');
    Object.assign(failure, { networkDiagnostic: { errorName: secret, code: secret, causeCode: 'ECONNRESET',
      phase: secret, elapsedMs: 86400000, requestBodyBytes: 512000, body: secret.repeat(100_000), token: secret, account: secret, url: secret, stack: secret } });
    logPlanFailure('responses', failure, { runId });
    expect(rows[0]).toMatchObject({ networkDiagnostic: { causeCode: 'ECONNRESET', elapsedMs: 86400000, requestBodyBytes: 512000 } });
    expect(safePlanNetworkDiagnostic({ elapsedMs: 0, requestBodyBytes: 0 })).toEqual({ elapsedMs: 0, requestBodyBytes: 0 });
    expect(JSON.stringify(rows)).not.toContain('PRIVATE'); expect(JSON.stringify(warning.mock.calls)).not.toContain('PRIVATE');
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(512);
    expect(safePlanFailureRecord({ observedAt: '2026-10-22T00:00:00.000Z', stage: 'responses', category: 'network_error',
      networkDiagnostic: { errorName: secret, code: secret, cause: { code: 'ENOTFOUND' }, arbitrary: secret } }))
      .toEqual({ observedAt: '2026-10-22T00:00:00.000Z', stage: 'responses', category: 'network_error' });
  } finally { unobserve(); }
});

it('preserves existing HTTP/body diagnostics without adding network metadata after headers were returned', async () => {
  const fetchFn = vi.fn(async () => Response.json({ error: { code: 'rate_limit_exceeded', message: secret } }, { status: 429 }));
  const failure = await requestPlanResponse({ fetchFn, body, model: 'fixture-model', signal: new AbortController().signal,
    accessToken: async () => 'PRIVATE fixture access token', validate: () => {} }).catch(error => error);
  expect(failure).toMatchObject({ category: 'http_error', httpStatus: 429, responseDiagnostic: { errorCode: 'rate_limit_exceeded' } });
  expect(failure.networkDiagnostic).toBeUndefined(); expect(fetchFn).toHaveBeenCalledOnce();
  expect(JSON.stringify(failure)).not.toContain('PRIVATE');
});

it('persists the new metadata in the unchanged private 128-record/64KiB/24h store', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const parent = await mkdtemp(join(tmpdir(), 'matrix-plan-network-diagnostic-'));
  const directory = join(parent, 'diagnostics'), file = join(directory, 'chatgpt-plan-failures.json');
  let clock = Date.parse('2026-10-22T00:00:00.000Z');
  const store = createPlanDiagnosticStore({ directory, now: () => clock });
  try {
    for (let index = 0; index < 300; index++) logPlanFailure('responses', new PlanFailure('responses', 'network_error', undefined, undefined,
      { errorName: 'TypeError', code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', causeCode: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
        phase: 'before_headers', elapsedMs: 86400000, requestBodyBytes: 512000 }),
    { runId: 'run_' + index.toString(16).padStart(32, '0'), requestId: '10000000-0000-4000-8000-000000000001',
      computerId: '30000000-0000-4000-8000-000000000001', body: secret });
    expect(await store.flush()).toBe(true);
    const text = await readFile(file, 'utf8'), rows = JSON.parse(text);
    expect(rows.length).toBeGreaterThan(0); expect(rows.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(65536);
    expect(rows.at(-1).networkDiagnostic).toEqual({ errorName: 'TypeError', code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE',
      causeCode: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', phase: 'before_headers', elapsedMs: 86400000, requestBodyBytes: 512000 });
    expect(rows.at(-1).correlation.runId).toBe('run_0000000000000000000000000000012b');
    expect(text).not.toContain('PRIVATE'); expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    clock += 25 * 60 * 60_000;
    // Existing flush pruning removes these records after the unchanged 24h TTL.
    logPlanFailure('peer_reply', new Error(secret)); expect(await store.flush()).toBe(true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([{ observedAt: new Date(clock).toISOString(), stage: 'peer_reply', category: 'local_failure' }]);
  } finally { await store.close(); await rm(parent, { recursive: true, force: true }); }
});
