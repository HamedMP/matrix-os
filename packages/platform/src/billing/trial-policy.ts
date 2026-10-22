import { MATRIX_HOSTED_BILLING_PLAN_SLUGS, type MatrixHostedBillingPlanSlug, type MatrixBillingStatus } from '@matrix-os/contracts';
import { MATRIX_CARD_TRIAL_DAYS, MATRIX_STARTER_TRIAL_DAYS } from './checkout-schemas.js';

/** New offers only. Persisted Checkout promises take precedence over this policy. */
export function resolveNewCardTrialDays(
  planSlug: MatrixHostedBillingPlanSlug,
  starterDurationDays: number,
  otherDurationDays = MATRIX_CARD_TRIAL_DAYS,
): number {
  return planSlug === 'matrix_starter' ? starterDurationDays : otherDurationDays;
}

export function projectCardTrialOffer(input: {
  enabled: boolean;
  eligible: boolean;
  durationDays: number;
  starterDurationDays?: number;
  activeAttempt?: {
    planSlug: MatrixHostedBillingPlanSlug | null;
    trialPeriodDays: number | null;
  };
}): MatrixBillingStatus['trialOffer'] {
  const reserved = input.activeAttempt;
  if (reserved) {
    const eligible = reserved.trialPeriodDays !== null && reserved.planSlug !== null;
    return {
      eligible,
      durationDays: reserved.trialPeriodDays ?? input.durationDays,
      eligiblePlanSlugs: eligible ? [reserved.planSlug!] : [],
      durationDaysByPlan: eligible ? { [reserved.planSlug!]: reserved.trialPeriodDays! } : {},
    };
  }
  const eligible = input.enabled && input.eligible;
  return {
    eligible,
    // Older clients retain their established three-day display. New clients use
    // the selected plan's explicit duration, which also drives Stripe Checkout.
    durationDays: input.durationDays,
    eligiblePlanSlugs: eligible ? [...MATRIX_HOSTED_BILLING_PLAN_SLUGS] : [],
    durationDaysByPlan: eligible ? {
      matrix_starter: input.starterDurationDays ?? MATRIX_STARTER_TRIAL_DAYS,
      matrix_builder: input.durationDays,
      matrix_max: input.durationDays,
    } : {},
  };
}
