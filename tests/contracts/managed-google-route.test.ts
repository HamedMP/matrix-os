import { describe, expect, it } from 'vitest';
import { ManagedGoogleRouteDescriptorSchema, MANAGED_GOOGLE_CONTROL_POLICY_VERSION, serializeManagedGoogleRouteDescriptor } from '../../packages/contracts/src/managed-google-route.js';

const endpoint = 'https://api.cloudflare.com/client/v4/accounts/' + 'a'.repeat(32) + '/ai/run/@cf/zai-org/glm-5.3-flash';
function descriptor() { return { version: 1, kind: 'cloudflare-workers-ai', routeId: 'private_route_one', routeRevision: 1,
  evidence: { referenceDigest: 'a'.repeat(64), accountSettingsReferenceDigest: 'b'.repeat(64), reviewedAt: '2026-10-21T12:00:00.000Z', expiresAt: '2026-11-01T12:00:00.000Z' },
  relay: { endpoint: 'https://relay.example.invalid/v1/chat/completions', api: 'openai-completions' },
  upstream: { endpoint, api: 'cloudflare-workers-ai-run', nativeModelId: '@cf/zai-org/glm-5.3-flash', canonicalModelId: '@cf/zai-org/glm-5.3-flash' },
  cloudflare: { accountId: 'a'.repeat(32), gatewayId: 'gateway-one', credentialMode: 'workers-ai-api-token' },
  credential: { generation: '123e4567-e89b-42d3-a456-426614174000', fingerprint: 'c'.repeat(64) },
  recipientChain: [{ recipientId: 'cloudflare', accountId: 'a'.repeat(32), endpoint }], controlPolicyVersion: MANAGED_GOOGLE_CONTROL_POLICY_VERSION };
}
describe('strict content-free managed Google route descriptor', () => {
  it('serializes only bounded explicit facts with deterministic property order', () => {
    const value = descriptor(); expect(ManagedGoogleRouteDescriptorSchema.parse(value)).toEqual(value);
    expect(serializeManagedGoogleRouteDescriptor(Object.fromEntries(Object.entries(value).reverse()))).toBe(JSON.stringify(value));
  });
  it.each(['version', 'provider', 'account', 'credential', 'model', 'endpoint', 'relay', 'chain', 'duplicate', 'cap', 'window', 'settings', 'policy', 'secret'] as const)('rejects invalid %s proof shape', invalid => {
    const value: any = descriptor();
    if (invalid === 'version') value.version = 2; if (invalid === 'provider') value.kind = 'aws-bedrock';
    if (invalid === 'account') value.cloudflare.accountId = 'other-account'; if (invalid === 'credential') value.credential.generation = 'temporary-lease-id';
    if (invalid === 'model') value.upstream.nativeModelId = '@cf/unknown/model'; if (invalid === 'endpoint') value.upstream.endpoint = 'https://api.other.example/v1';
    if (invalid === 'relay') value.relay.endpoint += '?secret=hidden'; if (invalid === 'chain') value.recipientChain[0].accountId = 'another';
    if (invalid === 'duplicate') value.recipientChain.push(value.recipientChain[0]);
    if (invalid === 'cap') value.recipientChain = Array(17).fill(value.recipientChain[0]);
    if (invalid === 'window') value.evidence.expiresAt = value.evidence.reviewedAt;
    if (invalid === 'settings') delete value.evidence.accountSettingsReferenceDigest;
    if (invalid === 'policy') value.controlPolicyVersion = 'pretend-zdr'; if (invalid === 'secret') value.credential.rawToken = 'private';
    expect(ManagedGoogleRouteDescriptorSchema.safeParse(value).success).toBe(false);
  });
});
