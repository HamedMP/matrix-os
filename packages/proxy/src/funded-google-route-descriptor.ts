import { createHash } from 'node:crypto';
import { CloudflareManagedGoogleRouteReviewSchema, ManagedGoogleRouteDescriptorSchema,
  MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN, isManagedWorkersAiModel, serializeManagedGoogleRouteDescriptor,
  type ManagedGoogleRouteDescriptor } from '@matrix-os/contracts';
import type { FundedRelayConfig } from './funded-relay-config.js';
import { mapFundedModel } from './funded-relay-model.js';
import { workersAiTarget } from './funded-relay-openai-request.js';

const gateway = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([a-f0-9]{32})\/([A-Za-z0-9_-]{1,64})\/anthropic$/;
function relayEndpoint(base: string): string | null {
  if (typeof base !== 'string' || base.length > 2048) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || url.href.replace(/\/$/, '') !== base.replace(/\/$/, '')) return null;
    return `${base.replace(/\/$/, '')}/v1/chat/completions`;
  } catch (error) { if (error instanceof TypeError) return null; throw error; }
}
/** SHA-256 over the domain and strict schema projection, never temporary lease/token bytes. */
export function managedGoogleRouteDescriptorDigest(value: unknown): string {
  return createHash('sha256').update(MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN).update(serializeManagedGoogleRouteDescriptor(value)).digest('hex');
}

/** Pure server-only comparison with SAME dispatch config/model. No approvals, account-setting probes,
 * env reads, network, lease mutation or relay installation. Generation/account evidence is operator
 * supplied and must be separately reviewed/revalidated; the hash comes from the ACTUAL stable Workers
 * credential. Neither gateway auth nor ephemeral Matrix leases identify that upstream credential.
 * Anthropic's current implicit stored-BYOK/Unified-Billing selection is deliberately unrepresentable. */
export function buildCloudflareManagedGoogleRouteDescriptor(input: {
  config: Pick<FundedRelayConfig, 'gatewayBaseUrl' | 'workersAiToken' | 'reservationMode'>;
  /** Trusted deployment URL used by the host broker, not request Host or model input. */
  relayBaseUrl: string; api: 'openai-completions' | 'anthropic-messages' | 'openai-responses';
  modelId: string; review: unknown; now: Date;
}): { descriptor: ManagedGoogleRouteDescriptor; digest: string } | null {
  const review = CloudflareManagedGoogleRouteReviewSchema.safeParse(input.review);
  const at = input.now.getTime();
  if (!review.success || !Number.isSafeInteger(at) || input.api !== 'openai-completions'
    || input.config.reservationMode !== 'usage' || !isManagedWorkersAiModel(input.modelId)
    || at < Date.parse(review.data.evidence.reviewedAt) || at >= Date.parse(review.data.evidence.expiresAt)) return null;
  const actualGateway = gateway.exec(input.config.gatewayBaseUrl);
  const actualRelay = relayEndpoint(input.relayBaseUrl); const token = input.config.workersAiToken;
  if (!actualGateway || !actualRelay || typeof token !== 'string' || !/^[\x21-\x7e]{32,4096}$/.test(token) || token.startsWith('sk-matrix-funded-')) return null;
  const model = mapFundedModel(input.modelId); const target = workersAiTarget(input.config.gatewayBaseUrl, model.nativeModelId);
  const fingerprint = createHash('sha256').update(token).digest('hex');
  const expected = review.data;
  if (expected.relay.endpoint !== actualRelay || expected.cloudflare.accountId !== actualGateway[1]
    || expected.cloudflare.gatewayId !== target.gatewayId || expected.upstream.endpoint !== target.url
    || expected.upstream.nativeModelId !== model.nativeModelId || expected.upstream.canonicalModelId !== model.canonicalModelId
    || expected.credential.fingerprint !== fingerprint) return null;
  const parsed = ManagedGoogleRouteDescriptorSchema.safeParse({ version: 1, kind: 'cloudflare-workers-ai', ...expected,
    relay: { endpoint: actualRelay, api: input.api }, upstream: { endpoint: target.url, api: 'cloudflare-workers-ai-run', ...model },
    cloudflare: { accountId: actualGateway[1], gatewayId: target.gatewayId, credentialMode: 'workers-ai-api-token' },
    credential: { generation: expected.credential.generation, fingerprint } });
  if (!parsed.success) return null;
  return { descriptor: parsed.data, digest: managedGoogleRouteDescriptorDigest(parsed.data) };
}
