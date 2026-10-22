import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createBotIntegrationClient, createLocalIntegrationTransport, createPlatformIntegrationTransport } from '../../packages/gateway/src/bots/integration-client.js';
import { GOOGLE_PROCESSING_HEADER, verifyGoogleProcessingEnvelope, type GoogleProcessingClaim } from '../../packages/gateway/src/google-data/runtime/envelope.js';

const owner = 'user_owner_1';
const account = '00000000-0000-4000-8000-000000000001';
const machineToken = 'synthetic-machine-token';
const claim = (): GoogleProcessingClaim => ({ ownerId: owner, googleAccountId: account,
  runId: 'run-1', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1',
  profileId: '00000000-0000-4000-8000-000000000002', profileRevision: 1,
  consentId: '00000000-0000-4000-8000-000000000003', consentRevision: 1,
  collectionExpiresAt: new Date(Date.now() + 60000).toISOString(), purposeId: 'mail-assistance', routeDigest: 'b'.repeat(64), policyExpiresAt: new Date(Date.now() + 60000).toISOString() });
const input = { service: 'gmail', action: 'get_message', label: 'Work', connectionId: account, params: { messageId: 'm1' }, read: true };
function fixture() {
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ data: { ok: true } })));
  const transport = createPlatformIntegrationTransport({ baseUrl: 'https://platform.invalid/i', machineToken, fetchImpl: fetcher as typeof fetch });
  return { fetcher, transport, client: createBotIntegrationClient(transport) };
}
describe('private Google processing transport', () => {
  it.each([true, false])('signs the exact outgoing bytes and path (read=%s), keeping claims outside JSON', async read => {
    const f = fixture(); const processingClaim = claim();
    await f.client.call(owner, { ...input, read, processingClaim });
    const [url, init] = f.fetcher.mock.calls[0]!;
    const body = String(init.body), path = read ? '/read-call' : '/call';
    const header = new Headers(init.headers).get(GOOGLE_PROCESSING_HEADER);
    expect(url).toBe(`https://platform.invalid/i${path}`); expect(header).toBeTruthy();
    expect(verifyGoogleProcessingEnvelope(header!, { ownerId: owner, machineToken, method: 'POST', path, body })).toMatchObject(processingClaim);
    expect(JSON.parse(body)).toEqual({ service: 'gmail', action: 'get_message', label: 'Work', connectionId: account, params: { messageId: 'm1' } });
  });
  it('mints a new one-use request ID for each dispatch', async () => {
    const f = fixture(); const processingClaim = claim();
    for (let i = 0; i < 2; i++) await f.client.call(owner, { ...input, processingClaim });
    const ids = f.fetcher.mock.calls.map(([, init]) => verifyGoogleProcessingEnvelope(new Headers(init.headers).get(GOOGLE_PROCESSING_HEADER)!, {
      ownerId: owner, machineToken, method: 'POST', path: '/read-call', body: String(init.body) }).requestId);
    expect(ids[0]).not.toBe(ids[1]);
  });
  it.each(['owner', 'account', 'service', 'missing-account', 'expired'] as const)('refuses a mismatched %s before fetch', async changed => {
    const f = fixture(); const processingClaim = claim(); const request = { ...input, processingClaim };
    if (changed === 'owner') processingClaim.ownerId = 'other';
    if (changed === 'account') request.connectionId = '00000000-0000-4000-8000-000000000009';
    if (changed === 'service') request.service = 'github';
    if (changed === 'missing-account') delete (request as { connectionId?: string }).connectionId;
    if (changed === 'expired') processingClaim.policyExpiresAt = new Date(0).toISOString();
    await expect(f.client.call(owner, request)).rejects.toMatchObject({ code: 'unavailable' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(['/connect', '/gmail/processing/authorize', '/read-call?bypass=1', '/'])('refuses a claim on the unreviewed path %s', async path => {
    const f = fixture();
    await expect(Promise.resolve().then(() => f.transport(owner, { method: 'POST', path, body: { ...input }, processingClaim: claim(), signal: new AbortController().signal }))).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not interpret a model parameter as processing authority', async () => {
    const f = fixture(); await f.client.call(owner, { ...input, params: { processingClaim: claim() } });
    expect(new Headers(f.fetcher.mock.calls[0]![1].headers).get(GOOGLE_PROCESSING_HEADER)).toBeNull();
  });
  it('rejects already-aborted direct transport before signing or sending', async () => {
    const f = fixture(); const aborted = AbortSignal.abort();
    await expect(Promise.resolve().then(() => f.transport(owner, { method: 'POST', path: '/read-call', body: input, processingClaim: claim(), signal: aborted }))).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not silently downgrade a claim through an unqualified local transport', async () => {
    const routes = new Hono(); const action = vi.fn(c => c.json({ data: {} })); routes.post('/read-call', action);
    const client = createBotIntegrationClient(createLocalIntegrationTransport(routes));
    await expect(client.call(owner, { ...input, processingClaim: claim() })).rejects.toMatchObject({ code: 'unavailable' });
    expect(action).not.toHaveBeenCalled();
  });
});
