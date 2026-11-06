export const MANAGED_CREDIT_MAX_AGE_MS = 5 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;

/** Match Gateway funding freshness without rewriting the server observation. */
export function isManagedCreditTimestampCurrent(asOf: string, now: number): boolean {
  const age = now - Date.parse(asOf);
  return Number.isFinite(age) && age >= -MAX_FUTURE_SKEW_MS && age <= MANAGED_CREDIT_MAX_AGE_MS;
}
