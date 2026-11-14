import { verifyToken } from '@clerk/backend';
import { createClerkAuth, resolveClerkVerificationConfig } from './clerk-auth.js';

/** Separate verifier: allowing approval must not widen preview token policy. */
export function createDevstackApprovalAuth(env: NodeJS.ProcessEnv, origin: string, issuer: string) {
  const config = resolveClerkVerificationConfig({ ...env, CLERK_AUTHORIZED_ORIGIN: origin });
  if (!config) throw new Error('DevStack approval verification is unavailable.');
  return createClerkAuth({
    verifyToken: token => verifyToken(token, config.verifyTokenOptions),
    requiredClaims: { issuer, authorizedParty: origin },
  });
}
