/** Operator configuration only. An allowlist never authenticates an actor. */
export type PilotCohortPolicy =
  | Readonly<{ status: 'disabled' }>
  | Readonly<{ status: 'enabled'; allowedClerkIds: readonly string[] }>
  | Readonly<{ status: 'invalid' }>;

const DISABLED: PilotCohortPolicy = Object.freeze({ status: 'disabled' });
const INVALID: PilotCohortPolicy = Object.freeze({ status: 'invalid' });
const CLERK_USER_ID = /^user_[A-Za-z0-9]{1,123}$/;

export function loadPilotCohortPolicy(env: Readonly<Record<string, string | undefined>>): PilotCohortPolicy {
  const enabled = env.MATRIX_PILOT_ACCESS_ENABLED;
  if (enabled === undefined || enabled === 'false') return DISABLED;
  if (enabled !== 'true') return INVALID;
  const raw = env.MATRIX_PILOT_ALLOWED_CLERK_IDS;
  if (!raw || raw.length > 12_999) return INVALID;
  const values = raw.split(',');
  if (values.length > 100) return INVALID;
  const ids = values.map(value => value.trim());
  if (ids.some(id => !CLERK_USER_ID.test(id))) return INVALID;
  return Object.freeze({ status: 'enabled', allowedClerkIds: Object.freeze([...new Set(ids)]) });
}

export function isPilotCohortMember(policy: PilotCohortPolicy, clerkUserId: string | null | undefined): boolean {
  return policy.status === 'disabled' || (policy.status === 'enabled'
    && typeof clerkUserId === 'string' && CLERK_USER_ID.test(clerkUserId)
    && policy.allowedClerkIds.includes(clerkUserId));
}
