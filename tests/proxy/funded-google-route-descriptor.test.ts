import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildCloudflareManagedGoogleRouteDescriptor, managedGoogleRouteDescriptorDigest } from '../../packages/proxy/src/funded-google-route-descriptor.js';
import { resolveFundedRelayConfig } from '../../packages/proxy/src/funded-relay-config.js';
import { workersAiTarget } from '../../packages/proxy/src/funded-relay-openai-request.js';
import { MANAGED_GOOGLE_CONTROL_POLICY_VERSION } from '../../packages/contracts/src/managed-google-route.js';
import { MANAGED_WORKERS_AI_MODEL_IDS } from '../../packages/contracts/src/funded-workers-models.js';

const now = new Date('2026-10-22T12:00:00.000Z');
const account = 'a'.repeat(32); const model = '@cf/zai-org/glm-5.3-flash';
const key = 'synthetic-stable-workers-token-not-a-real-credential';
const upstream = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function config() { return resolveFundedRelayConfig({ MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_FUNDED_AI_RESERVATION_MODE: 'usage',
  CLOUDFLARE_AI_GATEWAY_URL: `https://gateway.ai.cloudflare.com/v1/${account}/gateway-one/anthropic`,
  CLOUDFLARE_AI_GATEWAY_TOKEN: 'synthetic-gateway-only-token-not-a-provider-key', CLOUDFLARE_WORKERS_AI_TOKEN: key,
  PLATFORM_INTERNAL_URL: 'https://platform.example.invalid', AI_RELAY_CONTROL_TOKEN: 'synthetic-relay-control-token-not-a-provider-key',
  AI_RELAY_METADATA_SECRET: 'synthetic-private-metadata-key-not-a-provider-key' })!; }
export function review() { return { routeId: 'managed_route_one', routeRevision: 1,
  evidence: { referenceDigest: 'b'.repeat(64), accountSettingsReferenceDigest: 'c'.repeat(64),
    reviewedAt: '2026-10-21T12:00:00.000Z', expiresAt: '2026-10-29T12:00:00.000Z' },
  relay: { endpoint: 'https://relay.example.invalid/v1/chat/completions', api: 'openai-completions' },
  upstream: { endpoint: upstream, api: 'cloudflare-workers-ai-run', nativeModelId: model, canonicalModelId: model },
  cloudflare: { accountId: account, gatewayId: 'gateway-one', credentialMode: 'workers-ai-api-token' },
  credential: { generation: '123e4567-e89b-42d3-a456-426614174000', fingerprint: hash(key) },
  recipientChain: [{ recipientId: 'cloudflare', accountId: account, endpoint: upstream }],
  controlPolicyVersion: MANAGED_GOOGLE_CONTROL_POLICY_VERSION };
}
const input = () => ({ config: config(), relayBaseUrl: 'https://relay.example.invalid', api: 'openai-completions' as const, modelId: model, review: review(), now });

describe('pure actual Cloudflare Workers Google route descriptor', () => {
  it('uses the same config/model target as dispatch, stable actual upstream credential hash and exact reviewed facts', () => {
    const value = input(); const before = structuredClone(value.review); const result = buildCloudflareManagedGoogleRouteDescriptor(value)!;
    expect(result.descriptor).toEqual({ version: 1, kind: 'cloudflare-workers-ai', ...before });
    expect(result.descriptor.upstream.endpoint).toBe(workersAiTarget(value.config.gatewayBaseUrl, model).url);
    expect(result.descriptor.credential.fingerprint).toBe(hash(key)); expect(result.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(value.review).toEqual(before); expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(value.config.gatewayToken);
  });
  it.each(MANAGED_WORKERS_AI_MODEL_IDS)('describes exact configured dispatch facts for %s only after a matching review', modelId => {
    const value = input(); value.modelId = modelId;
    value.review.upstream = { ...value.review.upstream, nativeModelId: modelId, canonicalModelId: modelId,
      endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${modelId}` };
    value.review.recipientChain[0]!.endpoint = value.review.upstream.endpoint;
    expect(buildCloudflareManagedGoogleRouteDescriptor(value)?.descriptor.upstream).toEqual(value.review.upstream);
  });
  it.each(['anthropic', 'responses', 'unknown-model', 'missing-key', 'wrong-reservation', 'temporary-key'] as const)('does not manufacture a proof for %s', failure => {
    const value = input();
    if (failure === 'anthropic') { value.api = 'anthropic-messages' as never; value.modelId = 'claude-sonnet-5'; }
    if (failure === 'responses') value.api = 'openai-responses' as never;
    if (failure === 'unknown-model') value.modelId = '@cf/unreviewed/model';
    if (failure === 'missing-key') value.config.workersAiToken = undefined;
    if (failure === 'wrong-reservation') value.config.reservationMode = 'cloudflare-count';
    if (failure === 'temporary-key') { value.config.workersAiToken = `sk-matrix-funded-temporary.${'a'.repeat(43)}`;
      value.review.credential.fingerprint = hash(value.config.workersAiToken); }
    expect(buildCloudflareManagedGoogleRouteDescriptor(value)).toBeNull();
  });
  it.each(['review', 'account', 'gateway', 'relay', 'credential', 'generation', 'chain', 'policy', 'future-review', 'expired-review'] as const)('rejects missing or stale %s facts rather than substituting a route', failure => {
    const value = input();
    if (failure === 'review') value.review = undefined as never;
    if (failure === 'account') value.config.gatewayBaseUrl = value.config.gatewayBaseUrl.replace(account, 'd'.repeat(32));
    if (failure === 'gateway') value.config.gatewayBaseUrl = value.config.gatewayBaseUrl.replace('gateway-one', 'gateway-two');
    if (failure === 'relay') value.relayBaseUrl = 'https://another-relay.example.invalid';
    if (failure === 'credential') value.config.workersAiToken = 'synthetic-rotated-workers-token-not-a-real-credential';
    if (failure === 'generation') value.review.credential.generation = '';
    if (failure === 'chain') value.review.recipientChain[0]!.endpoint = 'https://other.example.invalid/v1';
    if (failure === 'policy') value.review.controlPolicyVersion = 'unreviewed-policy' as never;
    if (failure === 'future-review') value.review.evidence.reviewedAt = '2026-10-23T12:00:00.000Z';
    if (failure === 'expired-review') value.review.evidence.expiresAt = now.toISOString();
    expect(buildCloudflareManagedGoogleRouteDescriptor(value)).toBeNull();
  });
  it('does not confuse unused gateway credentials or an ephemeral lease with Workers upstream credential identity', () => {
    const value = input(); const first = buildCloudflareManagedGoogleRouteDescriptor(value)!;
    value.config.gatewayToken = 'synthetic-rotated-unused-gateway-key';
    expect(buildCloudflareManagedGoogleRouteDescriptor(value)).toEqual(first);
    expect(first.descriptor.credential.fingerprint).not.toBe(hash('sk-matrix-funded-synthetic-lease'));
  });
  it('changes the digest only after explicit review matches a rotated upstream credential generation', () => {
    const value = input(); const first = buildCloudflareManagedGoogleRouteDescriptor(value)!;
    value.config.workersAiToken = 'synthetic-rotated-workers-token-not-a-real-credential';
    expect(buildCloudflareManagedGoogleRouteDescriptor(value)).toBeNull();
    value.review.credential = { generation: '223e4567-e89b-42d3-a456-426614174000', fingerprint: hash(value.config.workersAiToken) };
    value.review.routeRevision = 2;
    const next = buildCloudflareManagedGoogleRouteDescriptor(value)!; expect(next.digest).not.toBe(first.digest);
    expect(next.descriptor.credential).toEqual(value.review.credential);
  });
  it('canonicalizes object keys for a deterministic digest while preserving ordered recipient routing', () => {
    const descriptor = buildCloudflareManagedGoogleRouteDescriptor(input())!.descriptor;
    const reversed = Object.fromEntries(Object.entries(descriptor).reverse());
    reversed.cloudflare = Object.fromEntries(Object.entries(descriptor.cloudflare).reverse());
    expect(managedGoogleRouteDescriptorDigest(reversed)).toBe(managedGoogleRouteDescriptorDigest(descriptor));
    const withOnward = { ...descriptor, recipientChain: [...descriptor.recipientChain,
      { recipientId: 'reviewed-onward', accountId: 'reviewed-account', endpoint: 'https://onward.example.invalid/v1' }] };
    expect(managedGoogleRouteDescriptorDigest(withOnward)).not.toBe(managedGoogleRouteDescriptorDigest(descriptor));
  });
  it.each(['https://gateway.ai.cloudflare.com.evil.test/v1/a/b/anthropic',
    `https://gateway.ai.cloudflare.com/v1/${account}/gateway-one/anthropic?key=hidden`,
    `https://user@gateway.ai.cloudflare.com/v1/${account}/gateway-one/anthropic`])('refuses nonactual canonical CF configuration %s', gatewayBaseUrl => {
    const value = input(); value.config.gatewayBaseUrl = gatewayBaseUrl;
    expect(buildCloudflareManagedGoogleRouteDescriptor(value)).toBeNull();
  });
});
