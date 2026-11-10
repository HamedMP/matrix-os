import { resolveFundedRelayConfig } from '../../packages/proxy/src/funded-relay-config.js';
import { FUNDED_PRICING_VERSIONS } from '../../packages/proxy/src/funded-pricing-review.js';
export const model = 'anthropic/claude-sonnet-5';
export const glm = '@cf/zai-org/glm-5.3-flash';
export const token = 'c'.repeat(32);
export const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
export function relayConfig(now: Date, platformBaseUrl = 'https://control.invalid') {
  const reviewedAt = new Date(+now - 86400_000).toISOString();
  const validThrough = new Date(+now + 86400_000).toISOString();
  return resolveFundedRelayConfig({
    MATRIX_FUNDED_AI_ENABLED: 'true', MATRIX_AI_RELAY_OPERATOR_PROBE_BUDGET_REQUIRED: 'true',
    MATRIX_FUNDED_AI_RESERVATION_MODE: 'usage', CLOUDFLARE_WORKERS_AI_TOKEN: 'w'.repeat(32),
    CLOUDFLARE_AI_GATEWAY_URL: 'https://gateway.ai.cloudflare.com/v1/0123456789abcdef0123456789abcdef/test/anthropic',
    CLOUDFLARE_AI_GATEWAY_TOKEN: 'g'.repeat(32), PLATFORM_INTERNAL_URL: platformBaseUrl,
    AI_RELAY_CONTROL_TOKEN: token, AI_RELAY_METADATA_SECRET: 'm'.repeat(32),
    MATRIX_FUNDED_SONNET_PRICING_REVIEW_VERSION: FUNDED_PRICING_VERSIONS[model],
    MATRIX_FUNDED_SONNET_PRICING_REVIEWED_AT: reviewedAt, MATRIX_FUNDED_SONNET_PRICING_VALID_THROUGH: validThrough,
    MATRIX_FUNDED_GLM_PRICING_REVIEW_VERSION: FUNDED_PRICING_VERSIONS[glm],
    MATRIX_FUNDED_GLM_PRICING_REVIEWED_AT: reviewedAt, MATRIX_FUNDED_GLM_PRICING_VALID_THROUGH: validThrough,
  })!;
}
