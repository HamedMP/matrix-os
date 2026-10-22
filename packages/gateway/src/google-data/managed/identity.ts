import { createHash } from 'node:crypto';
import { GoogleQualifiedFundedBindingSchema, GoogleQualifiedFundedRouteSchema,
  MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN, serializeManagedGoogleRouteDescriptor,
  type GoogleQualifiedFundedRoute, type GoogleQualifiedFundedBinding } from '@matrix-os/contracts';
import { SCOPE_RUNTIME_BOT_HARNESS_VERSION } from '@matrix-os/scope-runtime/bot-profile';
import type { PiRuntimeBinding } from '../../bots/runtime-registry.js';
import { GoogleInferencePolicyError, type GoogleInferenceIdentity } from '../runtime/inference-policy.js';

export function googleManagedRouteDigest(value: unknown): string {
  return createHash('sha256').update(MANAGED_GOOGLE_ROUTE_DIGEST_DOMAIN).update(serializeManagedGoogleRouteDescriptor(value)).digest('hex');
}
/** Internal stable downstream proof, never the temporary lease credential or an approval assertion. */
export function validGoogleManagedIdentity(identity: GoogleInferenceIdentity): boolean {
  const parsed = GoogleQualifiedFundedBindingSchema.safeParse(identity.managed); if (!parsed.success) return false;
  const proof = parsed.data;
  return Buffer.byteLength(JSON.stringify(proof)) <= 8192 && proof.digest === googleManagedRouteDigest(proof.descriptor)
    && identity.endpoint === proof.descriptor.relay.endpoint && identity.api === proof.api && identity.modelId === proof.canonicalModelId
    && identity.credential.kind === 'auth_token' && identity.credential.fingerprint === proof.descriptor.credential.fingerprint
    && identity.credential.generation === proof.descriptor.credential.generation;
}
export function googleManagedInferenceIdentity(binding: PiRuntimeBinding, routeValue: GoogleQualifiedFundedRoute): GoogleInferenceIdentity {
  const route = GoogleQualifiedFundedRouteSchema.parse(routeValue);
  if (binding.accessSourceId !== 'matrix_included' || binding.anthropicApi || binding.subscription || binding.route.api !== route.api
    || binding.route.modelId !== route.canonicalModelId) throw new GoogleInferencePolicyError();
  const managed: GoogleQualifiedFundedBinding = { ...route, requestClass: binding.requestClass };
  const identity: GoogleInferenceIdentity = { endpoint: route.descriptor.relay.endpoint, api: route.api, modelId: route.canonicalModelId,
    harnessVersion: SCOPE_RUNTIME_BOT_HARNESS_VERSION,
    credential: { kind: 'auth_token', fingerprint: route.descriptor.credential.fingerprint, generation: route.descriptor.credential.generation }, managed };
  if (!validGoogleManagedIdentity(identity)) throw new GoogleInferencePolicyError(); return identity;
}
