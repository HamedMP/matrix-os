import { GOOGLE_QUALIFIED_FUNDED_PROTOCOL, GoogleQualifiedFundedBindingSchema, parseGoogleQualifiedFundedCredential,
  type GoogleQualifiedFundedCheckResponse } from '@matrix-os/contracts';
import { createQualifiedFundedPlatformClient } from './funded-qualified-platform-client.js';
import { buildCloudflareManagedGoogleRouteDescriptor } from './funded-google-route-descriptor.js';
import { FundedControlPlaneError } from './funded-relay-platform-client.js';
import { parseManagedRouteControlConfig, type ManagedRouteControlConfig } from './managed-route-control-config.js';
import type { FundedRelayConfig } from './funded-relay-config.js';

export const isQualifiedFundedCredential = (value: string) => value.startsWith('sk-matrix-google-funded-');
/** Trusted optional composition. Same private config is read by this proof and the actual dispatch, never Host/model headers. */
export function createQualifiedFundedRoute(options: { config: FundedRelayConfig; settings?: ManagedRouteControlConfig; fetch: typeof fetch; now: () => Date; releaseRejected: (reservationId: string, tokenId: string) => Promise<boolean> }) {
  const settings = options.settings ? parseManagedRouteControlConfig(options.settings) : undefined;
  const client = createQualifiedFundedPlatformClient({ ...options.config, fetch: options.fetch });
  return (credential: string, model: string) => {
    if (!settings || !parseGoogleQualifiedFundedCredential(credential)) throw new FundedControlPlaneError(503);
    const reviews = settings.reviews.filter(review => review.upstream.canonicalModelId === model);
    if (reviews.length !== 1) throw new FundedControlPlaneError(503);
    const actual = () => {
      const result = buildCloudflareManagedGoogleRouteDescriptor({ config: options.config, relayBaseUrl: settings.relayBaseUrl,
        api: 'openai-completions', modelId: model, review: reviews[0], now: options.now() });
      if (!result) throw new FundedControlPlaneError(503); return result;
    };
    const original = actual(); let first: GoogleQualifiedFundedCheckResponse | undefined;
    const request = () => ({ protocol: GOOGLE_QUALIFIED_FUNDED_PROTOCOL, credential, api: 'openai-completions' as const,
      canonicalModelId: original.descriptor.upstream.canonicalModelId, expectedDigest: original.digest });
    function verify(value: GoogleQualifiedFundedCheckResponse, signal: AbortSignal) {
      signal.throwIfAborted(); const current = actual(); const tokenId = parseGoogleQualifiedFundedCredential(credential)?.tokenId;
      if (current.digest !== original.digest || value.binding.digest !== original.digest || value.authorization.identity.tokenId !== tokenId
        || value.binding.relayBaseUrl !== settings!.relayBaseUrl.replace(/\/$/, '') || value.binding.api !== request().api
        || value.binding.canonicalModelId !== model || JSON.stringify(value.binding.descriptor) !== JSON.stringify(original.descriptor)
        || Date.parse(value.authorization.identity.expiresAt) <= options.now().getTime()
        || Date.parse(value.authorization.policy.checkedAt) > options.now().getTime()
        || Date.parse(value.authorization.policy.staleAfter) <= options.now().getTime()
        || (first && (JSON.stringify(first.authorization.identity) !== JSON.stringify(value.authorization.identity)
          || JSON.stringify(first.binding) !== JSON.stringify(value.binding)))) throw new FundedControlPlaneError(503);
      GoogleQualifiedFundedBindingSchema.parse(value.binding);
    }
    return {
      async check(signal: AbortSignal) { signal.throwIfAborted(); actual(); const checked = await client.check(request(), signal); verify(checked, signal); first = checked; return checked.authorization; },
      async authorize(input: { requestId: string; maxCostMicrousd: number; claimKey?: string }, signal: AbortSignal) {
        if (!first) throw new FundedControlPlaneError(503); signal.throwIfAborted(); actual();
        const result = await client.authorize({ ...request(), ...input, billingMode: 'usage' }, signal);
        try {
          verify(result, signal);
          if (result.authorization.reservation.maxCostMicrousd !== input.maxCostMicrousd || result.authorization.reservation.requestId !== input.requestId
            || result.authorization.reservation.modelId !== model || Date.parse(result.authorization.reservation.expiresAt) <= options.now().getTime()) throw new FundedControlPlaneError(503);
          return result.authorization;
        } catch (error) {
          if (JSON.stringify(first.authorization.identity) === JSON.stringify(result.authorization.identity)
            && result.authorization.reservation.requestId === input.requestId)
            await options.releaseRejected(result.authorization.reservation.reservationId, result.authorization.identity.tokenId);
          throw error;
        }
      },
      async validate(signal: AbortSignal, target?: string) {
        if (!first) throw new FundedControlPlaneError(503); signal.throwIfAborted(); const before = actual();
        if (target !== undefined && target !== before.descriptor.upstream.endpoint) throw new FundedControlPlaneError(503);
        const checked = await client.check(request(), signal); verify(checked, signal);
      },
    };
  };
}
