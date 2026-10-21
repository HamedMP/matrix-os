import { describe, expect, it } from 'vitest';
import { resolveNewCardTrialDays, projectCardTrialOffer } from '../../packages/platform/src/billing/trial-policy.js';

describe('Starter trial policy', () => {
  it.each([7, 14])('offers %i days only on Starter', (days) => {
    expect(resolveNewCardTrialDays('matrix_starter', days)).toBe(days);
    expect(resolveNewCardTrialDays('matrix_builder', days)).toBe(3);
    expect(resolveNewCardTrialDays('matrix_max', days)).toBe(3);
  });

  it('advertises the same plan restriction that checkout enforces', () => {
    expect(projectCardTrialOffer({ enabled: true, eligible: true, durationDays: 3 })).toEqual({
      eligible: true, durationDays: 3, eligiblePlanSlugs: ['matrix_starter', 'matrix_builder', 'matrix_max'], durationDaysByPlan: { matrix_starter: 14, matrix_builder: 3, matrix_max: 3 },
    });
  });

  it('does not advertise trials for disabled or previously subscribed accounts', () => {
    for (const flags of [{ enabled: false, eligible: true }, { enabled: true, eligible: false }]) {
      expect(projectCardTrialOffer({ ...flags, durationDays: 3 })).toEqual({
        eligible: false, durationDays: 3, eligiblePlanSlugs: [], durationDaysByPlan: {},
      });
    }
  });

  it('preserves a reserved Builder trial even after the offer is withdrawn', () => {
    expect(projectCardTrialOffer({
      enabled: false, eligible: false, durationDays: 14,
      activeAttempt: { planSlug: 'matrix_builder', trialPeriodDays: 3 },
    })).toEqual({ eligible: true, durationDays: 3, eligiblePlanSlugs: ['matrix_builder'], durationDaysByPlan: { matrix_builder: 3 } });
  });

  it('does not advertise a trial while an immediate-payment checkout is reserved', () => {
    expect(projectCardTrialOffer({
      enabled: true, eligible: true, durationDays: 3,
      activeAttempt: { planSlug: 'matrix_builder', trialPeriodDays: null },
    })).toEqual({ eligible: false, durationDays: 3, eligiblePlanSlugs: [], durationDaysByPlan: {} });
  });

  it('fails closed for an old reservation without a known plan', () => {
    expect(projectCardTrialOffer({
      enabled: true, eligible: true, durationDays: 3,
      activeAttempt: { planSlug: null, trialPeriodDays: 3 },
    })).toEqual({ eligible: false, durationDays: 3, eligiblePlanSlugs: [], durationDaysByPlan: {} });
  });
});
