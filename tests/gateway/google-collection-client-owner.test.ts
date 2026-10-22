import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleOwnerConsentClient, GoogleOwnerConsentError } from '../../packages/gateway/src/google-data/runtime/owner-consent-client.js';
import type { BotIntegrationTransport } from '../../packages/gateway/src/bots/integration-client.js';
import { accountId, consentInput, profileInput } from './google-data/fixtures.js';

const profileId = '223e4567-e89b-42d3-a456-426614174000';
const notice = () => { const p = profileInput(); return { profileId, profileRevision: 1, googleAccountId: accountId,
  evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1, purposeId: p.purposeId, purpose: p.disclosure.purpose,
  recipients: p.disclosure.recipients, dataKinds: p.dataKinds, retention: p.retention, expiresAt: p.evidence.expiresAt,
  connectionType: 'byo', consentRevision: 0, consentActive: false }; };
const input = () => { const { ownerId: _owner, googleAccountId: _account, ...value } = consentInput(profileId);
  return { ...value, connectionId: accountId, accepted: true as const, expectedConsentRevision: 0 }; };
const json = (value: unknown, status = 200) => Response.json(value, { status });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('bounded Google owner consent settings client', () => {
  it.each([500, 401, 200])('cancels unread rejected/non-JSON bodies (status=%s)', async status => {
    const cancel = vi.fn(); const response = new Response(new ReadableStream({ cancel }), { status });
    await expect(createGoogleOwnerConsentClient(async () => response).disclosures('owner-one', accountId)).rejects.toBeDefined();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('cancels headers arriving after owner cancellation', async () => {
    const controller = new AbortController(); const cancel = vi.fn(); let finish!: (r: Response) => void;
    const pending = createGoogleOwnerConsentClient(() => new Promise<Response>(r => { finish = r; })).disclosures('owner-one', accountId, controller.signal);
    const rejected = expect(pending).rejects.toBeDefined(); controller.abort(); await rejected;
    finish(new Response(new ReadableStream({ cancel }))); await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('uses exact fixed paths, verified transport owner, and strict accepted CAS payload', async () => {
    const transport = vi.fn<BotIntegrationTransport>(async (_owner, r) => r.method === 'GET' ? json({ profiles: [notice()] }) : json({ consentRevision: 1, consentActive: true }));
    const client = createGoogleOwnerConsentClient(transport);
    expect(await client.disclosures('owner-one', accountId.toUpperCase())).toEqual([notice()]);
    expect(await client.recordConsent('owner-one', input())).toEqual({ consentRevision: 1, consentActive: true });
    expect(transport.mock.calls.map(([owner, r]) => [owner, r.method, r.path])).toEqual([
      ['owner-one', 'GET', `/gmail/processing-profiles?connectionId=${accountId}`], ['owner-one', 'POST', '/gmail/processing-consents']]);
    expect(transport.mock.calls[0]![1]).not.toHaveProperty('body'); expect(transport.mock.calls[1]![1].body).toEqual(input());
  });
  it.each(['owner', 'route', 'accepted', 'revision'] as const)('rejects illegal %s consent input before transport', async invalid => {
    const transport = vi.fn<BotIntegrationTransport>(); const value: any = input();
    if (invalid === 'owner') value.ownerId = 'other-owner'; if (invalid === 'route') value.routeDigest = 'a'.repeat(64);
    if (invalid === 'accepted') value.accepted = false; if (invalid === 'revision') value.expectedConsentRevision = -1;
    await expect(createGoogleOwnerConsentClient(transport).recordConsent('owner-one', value)).rejects.toBeInstanceOf(GoogleOwnerConsentError);
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(['account', 'duplicate', 'private-field', 'too-many', 'status', 'type', 'utf8', 'oversize'] as const)('rejects %s disclosures with generic diagnostics', async invalid => {
    let payload: unknown = { profiles: [notice()] };
    if (invalid === 'account') payload = { profiles: [{ ...notice(), googleAccountId: profileId }] };
    if (invalid === 'duplicate') payload = { profiles: [notice(), notice()] };
    if (invalid === 'private-field') payload = { profiles: [{ ...notice(), credentialFingerprint: 'private-provider-secret' }] };
    if (invalid === 'too-many') payload = { profiles: Array.from({ length: 101 }, () => notice()) };
    const transport: BotIntegrationTransport = async () => invalid === 'status' ? json({ error: 'private-provider-secret' }, 503)
      : invalid === 'type' ? new Response(JSON.stringify(payload))
      : invalid === 'utf8' ? new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } })
      : invalid === 'oversize' ? new Response(`{"profiles":[],"padding":"${'x'.repeat(1_048_576)}"}`, { headers: { 'content-type': 'application/json' } }) : json(payload);
    await expect(createGoogleOwnerConsentClient(transport).disclosures('owner-one', accountId)).rejects.toThrow('Google data settings unavailable');
  });
  it.each(['wrong-revision', 'inactive', 'extra'] as const)('rejects %s consent acknowledgments', async invalid => {
    const transport: BotIntegrationTransport = async () => json({ consentRevision: invalid === 'wrong-revision' ? 2 : 1,
      consentActive: invalid !== 'inactive', ...(invalid === 'extra' ? { ownerId: 'private-owner' } : {}) });
    await expect(createGoogleOwnerConsentClient(transport).recordConsent('owner-one', input())).rejects.toBeInstanceOf(GoogleOwnerConsentError);
  });
  it('bounds a stalled transport by the 10-second deadline', async () => {
    vi.useFakeTimers(); const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
    });
    const transport: BotIntegrationTransport = () => new Promise(() => {});
    const pending = createGoogleOwnerConsentClient(transport).disclosures('owner-one', accountId);
    const rejected = expect(pending).rejects.toBeInstanceOf(GoogleOwnerConsentError);
    await vi.advanceTimersByTimeAsync(10001); await rejected; expect(timeout).toHaveBeenCalledWith(10000);
  });
  it('cancels a stalled streamed response on caller abort', async () => {
    let cancelled = false;
    const transport: BotIntegrationTransport = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"profiles":[')); }, cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'application/json' } });
    const controller = new AbortController(); const pending = createGoogleOwnerConsentClient(transport).disclosures('owner-one', accountId, controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(GoogleOwnerConsentError);
    await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(); await rejected;
    expect(cancelled).toBe(true);
  });
});
