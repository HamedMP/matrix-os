import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Dispatcher } from 'undici';
import {
  createHostdClient,
  createHostdDispatcher,
  HostdError,
  HOSTD_RESPONSE_LIMIT_BYTES,
  HOSTD_SUSPEND_TIMEOUT_MS,
} from '../../packages/platform/src/substrates/hostd-client.js';
import { json, startFakeHostd, type FakeHostd } from './fake-hostd-server.js';

const TOKEN = 'a'.repeat(40);
const VM_ID = 'vm_0123456789abcdef01234567';

const VM = {
  id: VM_ID,
  machineId: 'machine-alice',
  generation: 3,
  handle: 'alice',
  tier: 'free',
  state: 'suspended',
  privateIPv4: '10.77.0.5',
  bootMiB: 2048,
  maxMiB: 8192,
  diskGiB: 20,
  chVersion: 'v48.0',
  snapshot: { takenAt: '2026-11-21T10:00:00.000Z', chVersion: 'v48.0' },
  updatedAt: '2026-11-21T10:00:00.000Z',
};

async function rejection(promise: Promise<unknown>): Promise<HostdError> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(HostdError);
  return error as HostdError;
}

describe('hostd client', () => {
  let hostd: FakeHostd;
  let dispatcher: Dispatcher;

  beforeAll(async () => {
    hostd = await startFakeHostd();
    dispatcher = createHostdDispatcher(hostd.caPem);
  });

  afterAll(async () => {
    await dispatcher.close();
    await hostd.close();
  });

  afterEach(() => {
    hostd.requests.length = 0;
  });

  function client(options: Parameters<typeof createHostdClient>[2] = {}) {
    return createHostdClient({ id: 'metal-1', apiUrl: hostd.origin }, TOKEN, { dispatcher, ...options });
  }

  it('resume sends the bearer token and budget and parses the state', async () => {
    hostd.handle((_req, res) => json(res, 200, { state: 'running' }));

    await expect(client().resume(VM_ID, 8000)).resolves.toEqual({ state: 'running' });

    const [req] = hostd.requests;
    expect(req).toMatchObject({ method: 'POST', path: `/v1/vms/${VM_ID}/resume` });
    expect(req!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(req!.body)).toEqual({ budgetMs: 8000 });
  });

  it('getVm parses the public VM record', async () => {
    hostd.handle((_req, res) => json(res, 200, VM));

    await expect(client().getVm(VM_ID)).resolves.toMatchObject({ id: VM_ID, generation: 3, state: 'suspended' });
    expect(hostd.requests[0]).toMatchObject({ method: 'GET', path: `/v1/vms/${VM_ID}` });
  });

  it('resume and suspend send expectedGeneration when fenced', async () => {
    hostd.handle((req, res) => (req.path.endsWith('/resume') ? json(res, 200, { state: 'running' }) : json(res, 202, { state: 'suspending' })));

    await client().resume(VM_ID, 8000, undefined, { expectedGeneration: 3 });
    await client().suspend(VM_ID, undefined, { expectedGeneration: 3 });

    expect(JSON.parse(hostd.requests[0]!.body)).toEqual({ budgetMs: 8000, expectedGeneration: 3 });
    expect(JSON.parse(hostd.requests[1]!.body)).toEqual({ expectedGeneration: 3 });
  });

  it('a fenced suspend waits past the API timeout for hostd to queue it (at least 135 s)', async () => {
    expect(HOSTD_SUSPEND_TIMEOUT_MS).toBeGreaterThanOrEqual(135_000);
    hostd.handle((_req, res) => { setTimeout(() => json(res, 202, { state: 'suspending' }), 150); });

    await expect(client({ timeoutMs: 50, suspendTimeoutMs: 1_000 }).suspend(VM_ID, undefined, { expectedGeneration: 3 }))
      .resolves.toEqual({ state: 'suspending' });
  });

  it('a generation mismatch on suspend is a conflict', async () => {
    hostd.handle((_req, res) => json(res, 409, { error: 'conflict' }));

    expect((await rejection(client().suspend(VM_ID, undefined, { expectedGeneration: 3 }))).code).toBe('conflict');
  });

  it('suspend accepts the 202 answer', async () => {
    hostd.handle((_req, res) => json(res, 202, { state: 'suspending' }));

    await expect(client().suspend(VM_ID)).resolves.toEqual({ state: 'suspending' });
    expect(hostd.requests[0]).toMatchObject({ method: 'POST', path: `/v1/vms/${VM_ID}/suspend` });
  });

  it('destroy accepts an empty 204 answer', async () => {
    hostd.handle((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    await expect(client().destroy(VM_ID)).resolves.toBeUndefined();
    expect(hostd.requests[0]).toMatchObject({ method: 'DELETE', path: `/v1/vms/${VM_ID}` });
  });

  it('verifies the hostd certificate: an untrusted certificate is unreachable', async () => {
    hostd.handle((_req, res) => json(res, 200, { state: 'running' }));
    const untrusted = createHostdClient({ id: 'metal-1', apiUrl: hostd.origin }, TOKEN);

    expect((await rejection(untrusted.resume(VM_ID, 1000))).code).toBe('unreachable');
    expect(hostd.requests).toHaveLength(0);
  });

  it.each([
    [409, 'conflict'],
    [404, 'not_found'],
    [503, 'busy'],
    [401, 'unauthorized'],
    [507, 'pool_full'],
    // The host's thin pool is too full for a new VM: placement tries another host.
    [503, 'capacity'],
  ] as const)('maps a %i %s answer to a typed error', async (status, code) => {
    hostd.handle((_req, res) => json(res, status, { error: code }));

    expect((await rejection(client().resume(VM_ID, 1000))).code).toBe(code);
  });

  it('parses the thin pool usage in capacity, or null when hostd cannot read it', async () => {
    const base = { memoryAvailableMiB: 1000, poolFreeBytes: 10, runningVms: 1, suspendedVms: 0 };
    hostd.handle((_req, res) => json(res, 200, { ...base, thinPool: { dataPercent: 41.5, metadataPercent: 12 } }));
    expect(await client().capacity()).toMatchObject({ thinPool: { dataPercent: 41.5, metadataPercent: 12 } });
    hostd.handle((_req, res) => json(res, 200, { ...base, thinPool: null }));
    expect((await client().capacity()).thinPool).toBeNull();
    hostd.handle((_req, res) => json(res, 200, { ...base, thinPool: { dataPercent: 140, metadataPercent: 12 } }));
    expect((await rejection(client().capacity())).code).toBe('invalid_response');
  });

  it('never surfaces hostd error text in the error message', async () => {
    hostd.handle((_req, res) => json(res, 500, { error: 'internal', detail: '/var/lib/matrix-hostd/vms/secret' }));

    const error = await rejection(client().getVm(VM_ID));
    expect(error.code).toBe('internal');
    expect(error.message).not.toContain('/var/lib');
  });

  it('an unknown error body maps by status to internal', async () => {
    hostd.handle((_req, res) => json(res, 502, { nope: true }));

    expect((await rejection(client().getVm(VM_ID))).code).toBe('internal');
  });

  it('a response that does not match the schema is invalid_response', async () => {
    hostd.handle((_req, res) => json(res, 200, { state: 'exploded' }));

    expect((await rejection(client().resume(VM_ID, 1000))).code).toBe('invalid_response');
  });

  it('a response body over the limit is invalid_response', async () => {
    hostd.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"state":"running","pad":"${'x'.repeat(HOSTD_RESPONSE_LIMIT_BYTES + 1024)}"}`);
    });

    expect((await rejection(client().resume(VM_ID, 1000))).code).toBe('invalid_response');
  });

  it('a hostd that never answers times out', async () => {
    hostd.handle(() => undefined);

    expect((await rejection(client({ timeoutMs: 100 }).getVm(VM_ID))).code).toBe('timeout');
  });

  it('resume waits for its budget plus the grace period, not the API timeout', async () => {
    hostd.handle((_req, res) => setTimeout(() => json(res, 200, { state: 'starting' }), 150));

    await expect(client({ timeoutMs: 50, resumeGraceMs: 50 }).resume(VM_ID, 300)).resolves.toEqual({ state: 'starting' });
    expect((await rejection(client({ timeoutMs: 5000, resumeGraceMs: 20 }).resume(VM_ID, 30))).code).toBe('timeout');
  });

  it('rejects a resume budget over 15000 ms without calling hostd', async () => {
    expect((await rejection(client().resume(VM_ID, 15_001))).code).toBe('bad_request');
    expect(hostd.requests).toHaveLength(0);
  });

  it('rejects a VM id that is not a hostd id without calling hostd', async () => {
    expect((await rejection(client().getVm('../capacity'))).code).toBe('bad_request');
    expect(hostd.requests).toHaveLength(0);
  });

  it('a caller abort rethrows the abort, not a hostd error', async () => {
    hostd.handle(() => undefined);
    const controller = new AbortController();
    const pending = client().getVm(VM_ID, controller.signal);
    setTimeout(() => controller.abort(new Error('caller gone')), 30);

    await expect(pending).rejects.toThrow('caller gone');
  });

  it('refuses a token shorter than 32 characters', () => {
    expect(() => createHostdClient({ id: 'metal-1', apiUrl: hostd.origin }, 'short')).toThrow();
  });
});
