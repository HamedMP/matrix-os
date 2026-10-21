import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGooglePlatformPolicyClient } from '../../packages/gateway/src/google-data/runtime/platform-client.js';
import { routeDigest } from '../../packages/gateway/src/google-data/profiles.js';
import { GOOGLE_POLICY_HARNESS_ID } from '../../packages/gateway/src/google-data/runtime/profile-resolution.js';
import { accountId, route } from './google-data/fixtures.js';
const generation = '523e4567-e89b-42d3-a456-426614174000';
const input = () => ({ binding: { runId: 'run_policy', runtimeHandle: `runtime_${'a'.repeat(32)}`, executionGeneration: '1', accessSourceId: 'owner_anthropic_key' }, googleAccountId: accountId, purposeId: 'mail-assistance', dataKinds: ['gmail-content'], identity: { endpoint: 'https://api.example.invalid/v1/messages', api: 'anthropic-messages', modelId: 'model-a', harnessVersion: 'reviewed-build-1', credential: { kind: 'api_key', fingerprint: 'a'.repeat(64), generation } } });
const resolvedRoute = () => route({ credentialKind: 'byo', credentialGeneration: generation, harnessId: GOOGLE_POLICY_HARNESS_ID['anthropic-messages'] });
const granted = () => ({ resolvedRoute: resolvedRoute(), stamp: { ownerId: 'owner-one', googleAccountId: accountId, purposeId: 'mail-assistance', profileId: generation, profileRevision: 1, evidenceRevision: 1, disclosureRevision: 1, retentionRevision: 1, consentId: '623e4567-e89b-42d3-a456-426614174000', consentRevision: 1, dataKinds: ['gmail-content'], routeDigest: routeDigest(resolvedRoute()), expiresAt: '2026-11-01T00:00:00Z' } });
afterEach(() => vi.useRealTimers());
describe('bounded server-only Google policy client', () => {
  it('rejects unrelated owner/account/purpose/kinds/route responses rather than borrowing authority', async () => {
    for (const override of [{ ownerId: 'other' }, { googleAccountId: generation }, { purposeId: 'other' }, { dataKinds: ['gmail-metadata'] }, { routeDigest: 'b'.repeat(64) }]) {
      const response = granted(); Object.assign(response.stamp, override);
      const client = createGooglePlatformPolicyClient(async () => Response.json(response));
      await expect(client.authorize('owner-one', input())).rejects.toMatchObject({ message: 'Google data processing unavailable' });
    }
  });
  it('does not allow revalidate to replace the original stamp', async () => {
    const response = granted(); response.stamp.consentRevision = 2;
    const client = createGooglePlatformPolicyClient(async () => Response.json(response));
    await expect(client.revalidate('owner-one', { ...input(), stamp: granted().stamp })).rejects.toMatchObject({ message: 'Google data processing unavailable' });
  });
  it('contains malformed, oversized, non-JSON and upstream private error responses', async () => {
    for (const response of [new Response('private provider error', { status: 500 }), new Response('not json', { headers: { 'content-type': 'application/json' } }), Response.json({ ...granted(), secret: 'forbidden' }), new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } }), new Response('private')]) {
      const client = createGooglePlatformPolicyClient(async () => response);
      await expect(client.authorize('owner-one', input())).rejects.toMatchObject({ message: 'Google data processing unavailable' });
    }
  });
  it('bounds a stalled transport and stops on cancellation even if it ignores signals', async () => {
    const control = new AbortController(); const called = vi.fn(async () => new Promise<Response>(() => undefined));
    const client = createGooglePlatformPolicyClient(called); const pending = client.authorize('owner-one', input(), control.signal);
    control.abort(); await expect(pending).rejects.toMatchObject({ message: 'Google data processing unavailable' });
    expect(called).toHaveBeenCalledTimes(1);
    await expect(client.authorize('owner-one', input(), control.signal)).rejects.toBeDefined(); expect(called).toHaveBeenCalledTimes(1);
  });
  it('cancels stalled response reads when the operation aborts', async () => {
    const control = new AbortController(); const cancel = vi.fn(); let reading!: () => void;
    const started = new Promise<void>(resolve => { reading = resolve; });
    const stream = new ReadableStream<Uint8Array>({ pull() { reading(); return new Promise(() => undefined); }, cancel });
    const client = createGooglePlatformPolicyClient(async () => new Response(stream, { headers: { 'content-type': 'application/json' } }));
    const pending = client.authorize('owner-one', input(), control.signal); await started; control.abort();
    await expect(pending).rejects.toBeDefined(); expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('rejects a different actual endpoint even with a self-consistent returned digest', async () => {
    const response = granted(); response.resolvedRoute.endpoint = 'https://other.example.invalid/v1/messages';
    response.resolvedRoute.recipientChain[0]!.endpoint = response.resolvedRoute.endpoint;
    response.stamp.routeDigest = routeDigest(response.resolvedRoute);
    await expect(createGooglePlatformPolicyClient(async () => Response.json(response)).authorize('owner-one', input())).rejects.toBeDefined();
  });
  it('enforces a ten-second deadline for transports that never settle', async () => {
    vi.useFakeTimers();
    const client = createGooglePlatformPolicyClient(async () => new Promise<Response>(() => undefined));
    const pending = expect(client.authorize('owner-one', input())).rejects.toMatchObject({ message: 'Google data processing unavailable' });
    await vi.advanceTimersByTimeAsync(10000); await pending;
  });

});
