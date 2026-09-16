/**
 * Funded-AI metering repository composition facade.
 *
 * Reads/grants live in ./ai-funded-metering/reads-grants.ts, reservations in
 * ./ai-funded-metering/reservations.ts, schemas/helpers in ./ai-funded-metering/codecs.ts.
 * Extracted from ./ai-funded-metering-repository.ts (Phase 1-A4). Pure move.
 */
import type { PlatformDB } from './db.js';
import { createMeteringReadsGrants } from './ai-funded-metering/reads-grants.js';
import { createMeteringReservations } from './ai-funded-metering/reservations.js';
export interface AiFundedMeteringRepositoryOptions {
  db: PlatformDB;
  credentialHashSecret: string;
  now: () => Date;
  policyFreshnessMs: number;
  reservationTtlMs: number;
  inFlightTtlMs: number;
  reservationIdFactory?: () => string;
}

export function createAiFundedMeteringRepository(options: AiFundedMeteringRepositoryOptions) {
  if (!options.db || options.credentialHashSecret.length < 32) {
    throw new Error("Funded AI metering dependencies are misconfigured");
  }
  if (options.policyFreshnessMs < 1_000 || options.policyFreshnessMs > 5 * 60_000
    || options.reservationTtlMs < 30_000 || options.reservationTtlMs > 15 * 60_000
    || options.inFlightTtlMs < 60_000 || options.inFlightTtlMs > 60 * 60_000) {
    throw new Error("Funded AI metering time limits are misconfigured");
  }
  const reads = createMeteringReadsGrants(options);
  const reservations = createMeteringReservations(options);
  return {
    getFundingSummary: reads.getFundingSummary,
    getRuntimeFundingSummary: reads.getRuntimeFundingSummary,
    checkPolicy: reads.checkPolicy,
    authorize: reservations.authorize,
    startReservation: reservations.startReservation,
    settleReservation: reservations.settleReservation,
    finalizeReservation: reservations.finalizeReservation,
    releaseReservation: reservations.releaseReservation,
    cleanupExpiredReservations: reads.cleanupExpiredReservations,
    grantCredit: reads.grantCredit,
    grantCreditInTransaction: reads.grantCreditInTransaction,
  };
}
