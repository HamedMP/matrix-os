import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { signGoogleProcessingEnvelope, verifyGoogleProcessingEnvelope, GOOGLE_PROCESSING_HEADER } from '../../packages/gateway/src/google-data/runtime/envelope.js';
import { integrationProxyHeaders } from '../../packages/gateway/src/integrations/custom-mcp/proxy-headers.js';

const now = Date.parse('2026-10-21T20:00:00.000Z');
const request = { method: 'POST', path: '/read-call', body: '{"service":"gmail","action":"get_message"}' };
const key = 'synthetic-machine-key-for-tests-only';
const claim = { ownerId: 'user_owner', runId: 'run_one', runtimeHandle: 'runtime_' + 'a'.repeat(32), executionGeneration: '1',
  profileId: '11111111-1111-4111-8111-111111111111', profileRevision: 1,
  consentId: '22222222-2222-4222-8222-222222222222', consentRevision: 1,
  googleAccountId: '33333333-3333-4333-8333-333333333333', purposeId: 'gmail_productivity',
  routeDigest: 'b'.repeat(64), policyExpiresAt: new Date(now + 60_000).toISOString() };
const read = (envelope: string, overrides = {}) => verifyGoogleProcessingEnvelope(envelope, { ...request, machineToken: key, ownerId: claim.ownerId, now, ...overrides });

describe('server-signed Google processing envelopes', () => {
  it('binds a short-lived exact owner/run/profile/account claim to request bytes', () => {
    const token = signGoogleProcessingEnvelope(claim, { ...request, machineToken: key, now });
    const verified = read(token);
    expect(verified).toMatchObject({ ...claim, issuedAt: now, expiresAt: now + 30_000 });
    expect(verified.requestId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it.each([
    { ownerId: 'user_other' }, { machineToken: 'other' }, { path: '/call' }, { method: 'GET' },
    { body: request.body + ' ' }, { now: now + 30_000 }, { now: now - 5_001 },
  ])('rejects changed identity, request or time: %j', overrides => {
    const token = signGoogleProcessingEnvelope(claim, { ...request, machineToken: key, now });
    expect(() => read(token, overrides)).toThrow('Google data request unavailable');
  });
  it('never outlives the current profile/consent decision', () => {
    const token = signGoogleProcessingEnvelope({ ...claim, policyExpiresAt: new Date(now + 700).toISOString() }, { ...request, machineToken: key, now });
    expect(read(token).expiresAt).toBe(now + 700);
    expect(() => read(token, { now: now + 700 })).toThrow();
  });
  it('bounds request bodies by UTF-8 bytes', () => {
    expect(() => signGoogleProcessingEnvelope(claim, { ...request, body: '😀'.repeat(20_000), machineToken: key, now })).toThrow();
  });
  it('rejects tampering, malformed or oversized envelopes and unknown claims', () => {
    const token = signGoogleProcessingEnvelope(claim, { ...request, machineToken: key, now });
    for (const value of [token + 'x', 'x.y', 'a'.repeat(16_385), token.replace(/.$/, token.endsWith('0') ? '1' : '0')]) expect(() => read(value)).toThrow();
    expect(() => signGoogleProcessingEnvelope({ ...claim, approved: true } as typeof claim, { ...request, machineToken: key, now })).toThrow();
    expect(() => signGoogleProcessingEnvelope({ ...claim, policyExpiresAt: new Date(now).toISOString() }, { ...request, machineToken: key, now })).toThrow();
  });
  it('strips caller-supplied processing claims from all integration proxy surfaces', async () => {
    const app = new Hono();
    app.get('/', c => c.json(Object.fromEntries(integrationProxyHeaders(c, '/api/integrations'))));
    const response = await app.request('/', { headers: { [GOOGLE_PROCESSING_HEADER]: 'forged', 'x-matrix-google-processing-proof': 'forged', accept: 'application/json' } });
    const headers = await response.json();
    expect(headers).toEqual({ accept: 'application/json' });
  });
});
