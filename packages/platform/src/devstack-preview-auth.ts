import { hasVerifiedClerkBrowserSession, type ClerkAuth, type VerifyResult } from './clerk-auth.js';
import type { RegisteredRuntimeEndpoint } from './devstack-registered-runtime.js';
import type { DevstackPreviewConfig, DevstackPreviewTarget } from './devstack-runs/config.js';

type DevstackBrowserSession = { session: VerifyResult; token: string };
export type DevstackBrowserMembership = (actorId: string, token: string) => Promise<boolean>;

export async function readDevstackBrowserSession(clerkAuth: ClerkAuth, cookie?: string): Promise<DevstackBrowserSession | null> {
  const token = clerkAuth.extractToken(undefined, cookie);
  if (!token || token.length > 8192) return null;
  const session = await clerkAuth.verify(token);
  return session.authenticated ? { session, token } : null;
}

export async function isDevstackBrowserOperator(
  { session, token }: DevstackBrowserSession,
  config: DevstackPreviewConfig,
  isMember: DevstackBrowserMembership,
): Promise<boolean> {
  const actor = session.userId;
  return Boolean(actor && session.issuer === config.issuer && !session.restrictedSession
    && config.operators.includes(actor) && hasVerifiedClerkBrowserSession(session, actor)
    && /^sess_[A-Za-z0-9_]{1,128}$/.test(session.sessionId) && await isMember(actor, token)
    && hasVerifiedClerkBrowserSession(session, actor));
}

export function matchesRegisteredPreviewTarget(
  endpoint: Pick<RegisteredRuntimeEndpoint, 'handle' | 'clerkUserId' | 'containerId'> | null,
  target: DevstackPreviewTarget,
): boolean {
  return endpoint?.containerId === target.containerId && endpoint.handle === target.handle && endpoint.clerkUserId === target.owner;
}
