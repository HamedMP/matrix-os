import { describe, expect, it } from 'vitest';
import { isPilotCohortMember, loadPilotCohortPolicy } from '@matrix-os/contracts';

describe('pilot cohort operator policy', () => {
  it('preserves disabled behavior, without validating unused allowlist', () => {
    expect(loadPilotCohortPolicy({})).toEqual({ status: 'disabled' });
    expect(isPilotCohortMember(loadPilotCohortPolicy({ MATRIX_PILOT_ACCESS_ENABLED: 'false', MATRIX_PILOT_ALLOWED_CLERK_IDS: 'garbage' }), undefined)).toBe(true);
  });
  it('accepts only exact immutable Clerk actors, trims and deduplicates bounded config', () => {
    const env = { MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: ' user_pilotA,user_pilotB,user_pilotA ' };
    const policy = loadPilotCohortPolicy(env);
    env.MATRIX_PILOT_ALLOWED_CLERK_IDS = 'user_outside';
    expect(policy).toEqual({ status: 'enabled', allowedClerkIds: ['user_pilotA', 'user_pilotB'] });
    expect(Object.isFrozen(policy)).toBe(true);
    if (policy.status === 'enabled') expect(Object.isFrozen(policy.allowedClerkIds)).toBe(true);
    for (const actor of ['user_pilotA', 'user_pilotB']) expect(isPilotCohortMember(policy, actor)).toBe(true);
    for (const actor of [undefined, '', 'user_pilota', ' user_pilotA', 'user_outside', 'pilotA@example.invalid']) expect(isPilotCohortMember(policy, actor)).toBe(false);
  });
  it.each([
    { MATRIX_PILOT_ACCESS_ENABLED: 'yes' },
    { MATRIX_PILOT_ACCESS_ENABLED: '' },
    { MATRIX_PILOT_ACCESS_ENABLED: 'true' },
    { MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: '' },
    ...['user_a,', 'user_a,,user_b', 'org_a', 'user_a@invalid', 'user_a\nuser_b', `user_${'a'.repeat(124)}`, Array.from({ length: 101 }, (_, i) => `user_a${i}`).join(',')].map(ids => ({ MATRIX_PILOT_ACCESS_ENABLED: 'true', MATRIX_PILOT_ALLOWED_CLERK_IDS: ids })),
  ])('fails closed on malformed or over-budget operator configuration %#', env => {
    const policy = loadPilotCohortPolicy(env);
    expect(policy).toEqual({ status: 'invalid' });
    expect(isPilotCohortMember(policy, 'user_a')).toBe(false);
  });
});
