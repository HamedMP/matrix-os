import { createHash } from 'node:crypto';
import { MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN, serializeManagedGoogleRouteDescriptor } from '../../packages/contracts/src/managed-google-route.js';

export const qualifiedNow = new Date('2026-10-22T12:00:00.000Z');
export const qualifiedIdentity = { ownerId: 'owner_one', machineId: 'machine_one', runtimeSlot: 'primary' };
export const qualifiedModel = '@cf/zai-org/glm-5.3-flash' as const;
export function qualifiedRouteFixture() {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/run/${qualifiedModel}`;
  const descriptor = { version: 1 as const, kind: 'cloudflare-workers-ai' as const, routeId: 'route_one', routeRevision: 1,
    evidence: { referenceDigest: 'a'.repeat(64), accountSettingsReferenceDigest: 'b'.repeat(64),
      reviewedAt: '2026-10-21T12:00:00.000Z', expiresAt: '2026-10-23T12:00:00.000Z' },
    relay: { endpoint: 'https://relay.example.test/private/v1/chat/completions', api: 'openai-completions' as const },
    upstream: { endpoint, api: 'cloudflare-workers-ai-run' as const, nativeModelId: qualifiedModel, canonicalModelId: qualifiedModel },
    cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'gateway-one', credentialMode: 'workers-ai-api-token' as const },
    credential: { generation: '123e4567-e89b-42d3-a456-426614174000', fingerprint: 'c'.repeat(64) },
    recipientChain: [{ recipientId: 'cloudflare', accountId: 'a'.repeat(32), endpoint }],
    controlPolicyVersion: 'matrix-cf-workers-request-controls-v1' as const };
  return { descriptor, digest: createHash('sha256').update(MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN)
    .update(serializeManagedGoogleRouteDescriptor(descriptor)).digest('hex'),
    relayBaseUrl: 'https://relay.example.test/private', api: descriptor.relay.api,
    canonicalModelId: qualifiedModel, evidenceExpiresAt: descriptor.evidence.expiresAt };
}
export function qualifiedLeaseFixture() {
  return { contractVersion: 1 as const, credential: { token: `sk-matrix-funded-token_one.${'s'.repeat(43)}`, tokenId: 'token_one',
    audience: 'matrix-funded-relay' as const, scope: 'ai:invoke' as const,
    issuedAt: qualifiedNow.toISOString(), expiresAt: '2026-10-22T12:15:00.000Z' }, identity: { ...qualifiedIdentity },
    requestClass: 'interactive' as const,
    policy: { enabled: true, globalRevision: 1, runtimeRevision: 1, allowedModelIds: [qualifiedModel],
      monthlyBudgetMicrousd: 1000, checkedAt: qualifiedNow.toISOString(), staleAfter: '2026-10-22T12:01:00.000Z' } };
}
