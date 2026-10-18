import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";

const MAX_PERIOD_MS = 366 * 86_400_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const milliseconds = z.number().int().min(0).max(MAX_PERIOD_MS);
const timestamp = z.number().int().min(0).max(MAX_TIMESTAMP);
const scopeSchema = z.object({ ownerId: id, periodId: id }).strict();
const reservationScopeSchema = z.object({ ownerId: id, reservationId: id }).strict();
const policySchema = scopeSchema.extend({ startsAt: timestamp, endsAt: timestamp, allowanceMs: milliseconds })
  .refine((value) => value.endsAt > value.startsAt && value.endsAt - value.startsAt <= MAX_PERIOD_MS);
const reserveSchema = scopeSchema.extend({ reservationId: id, amountMs: milliseconds.min(1).max(30 * 60_000), now: timestamp });
const settleSchema = reservationScopeSchema.extend({ actualMs: milliseconds });

export interface ComputePolicyTable {
  owner_id: string; period_id: string; starts_at: number; ends_at: number;
  allowance_ms: number; held_ms: number; settled_ms: number;
}
export interface ComputeReservationTable {
  owner_id: string; reservation_id: string; period_id: string; amount_ms: number;
  settled_ms: number | null; state: "held" | "uncertain" | "settled";
}
export interface ComputeBudgetDatabase {
  shared_compute_policies: ComputePolicyTable;
  shared_compute_reservations: ComputeReservationTable;
}
export type ComputePolicyInput = z.infer<typeof policySchema>;
export type ComputeReserveInput = z.infer<typeof reserveSchema>;
export type ComputeSettleInput = z.infer<typeof settleSchema>;
export interface ComputeReservation {
  ownerId: string; periodId: string; reservationId: string; amountMs: number;
  settledMs: number | null; state: ComputeReservationTable["state"];
}
export interface ComputeBudgetSnapshot {
  ownerId: string; periodId: string; startsAt: number; endsAt: number;
  allowanceMs: number; heldMs: number; settledMs: number; availableMs: number;
}
export class ComputeBudgetError extends Error {
  constructor(readonly code: "invalid" | "policy_unavailable" | "exhausted" | "conflict" | "not_found") {
    super("Compute budget unavailable"); this.name = "ComputeBudgetError";
  }
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ComputeBudgetError("invalid");
  return result.data;
}
const reservation = (row: ComputeReservationTable): ComputeReservation => ({
  ownerId: row.owner_id, periodId: row.period_id, reservationId: row.reservation_id,
  amountMs: row.amount_ms, settledMs: row.settled_ms, state: row.state,
});
function sameReservation(row: ComputeReservationTable, input: ComputeReserveInput): ComputeReservation {
  if (row.period_id !== input.periodId || row.amount_ms !== input.amountMs) throw new ComputeBudgetError("conflict");
  return reservation(row);
}

/** Server-only admission primitive for a caller-owned reservation + outbox transaction. */
export async function reserveComputeBudget(trx: Transaction<ComputeBudgetDatabase>, raw: ComputeReserveInput): Promise<ComputeReservation> {
  const input = parse(reserveSchema, raw);
  const policy = await trx.selectFrom("shared_compute_policies").selectAll()
    .where("owner_id", "=", input.ownerId).where("period_id", "=", input.periodId).forUpdate().executeTakeFirst();
  const existing = await trx.selectFrom("shared_compute_reservations").selectAll()
    .where("owner_id", "=", input.ownerId).where("reservation_id", "=", input.reservationId).executeTakeFirst();
  // Fingerprints remain authoritative across retries, expiry and period rollover.
  if (existing) return sameReservation(existing, input);
  if (!policy || input.now < policy.starts_at || input.now >= policy.ends_at) throw new ComputeBudgetError("policy_unavailable");
  if (input.amountMs > policy.allowance_ms - policy.held_ms - policy.settled_ms) throw new ComputeBudgetError("exhausted");
  const inserted = await trx.insertInto("shared_compute_reservations").values({
    owner_id: input.ownerId, reservation_id: input.reservationId, period_id: input.periodId,
    amount_ms: input.amountMs, settled_ms: null, state: "held",
  }).onConflict((oc) => oc.columns(["owner_id", "reservation_id"]).doNothing()).returningAll().executeTakeFirst();
  // Different period locks can contend on the owner-global reservation key.
  if (!inserted) {
    const raced = await trx.selectFrom("shared_compute_reservations").selectAll()
      .where("owner_id", "=", input.ownerId).where("reservation_id", "=", input.reservationId).executeTakeFirstOrThrow();
    return sameReservation(raced, input);
  }
  await trx.updateTable("shared_compute_policies").set({ held_ms: sql`held_ms + ${input.amountMs}` })
    .where("owner_id", "=", input.ownerId).where("period_id", "=", input.periodId).execute();
  return reservation(inserted);
}

/** Injected Postgres resources belong to the caller. This store never closes them.
 * Compute time is independent of inference funding. No policy is inferred or granted.
 */
export class PostgresComputeBudgetStore {
  constructor(readonly db: Kysely<ComputeBudgetDatabase>) {}
  async initialize(): Promise<void> {
    await this.db.schema.createTable("shared_compute_policies").ifNotExists()
      .addColumn("owner_id", "text", (c) => c.notNull()).addColumn("period_id", "text", (c) => c.notNull())
      .addColumn("starts_at", "double precision", (c) => c.notNull()).addColumn("ends_at", "double precision", (c) => c.notNull())
      .addColumn("allowance_ms", "double precision", (c) => c.notNull())
      .addColumn("held_ms", "double precision", (c) => c.notNull()).addColumn("settled_ms", "double precision", (c) => c.notNull())
      .addPrimaryKeyConstraint("shared_compute_policy_owner_period", ["owner_id", "period_id"])
      .addCheckConstraint("shared_compute_policy_window", sql`starts_at >= 0 and ends_at > starts_at and ends_at <= ${sql.lit(MAX_TIMESTAMP)} and ends_at - starts_at <= ${sql.lit(MAX_PERIOD_MS)} and starts_at = trunc(starts_at) and ends_at = trunc(ends_at)`)
      .addCheckConstraint("shared_compute_policy_amounts", sql`allowance_ms between 0 and ${sql.lit(MAX_PERIOD_MS)} and allowance_ms = trunc(allowance_ms) and held_ms between 0 and ${sql.lit(MAX_PERIOD_MS)} and held_ms = trunc(held_ms) and settled_ms between 0 and ${sql.lit(MAX_PERIOD_MS)} and settled_ms = trunc(settled_ms)`)
      .execute();
    await this.db.schema.createTable("shared_compute_reservations").ifNotExists()
      .addColumn("owner_id", "text", (c) => c.notNull()).addColumn("reservation_id", "text", (c) => c.notNull())
      .addColumn("period_id", "text", (c) => c.notNull()).addColumn("amount_ms", "double precision", (c) => c.notNull())
      .addColumn("settled_ms", "double precision").addColumn("state", "text", (c) => c.notNull())
      .addPrimaryKeyConstraint("shared_compute_reservation_owner_key", ["owner_id", "reservation_id"])
      .addForeignKeyConstraint("shared_compute_reservation_policy", ["owner_id", "period_id"], "shared_compute_policies", ["owner_id", "period_id"])
      .addCheckConstraint("shared_compute_reservation_amount", sql`amount_ms between 1 and 1800000 and amount_ms = trunc(amount_ms)`)
      .addCheckConstraint("shared_compute_reservation_state", sql`(state in ('held', 'uncertain') and settled_ms is null) or (state = 'settled' and settled_ms is not null and settled_ms between 0 and amount_ms and settled_ms = trunc(settled_ms))`)
      .execute();
  }
  /** Trusted provisioning only. A downgrade preserves every prior debit and hold. */
  async provisionPolicy(raw: ComputePolicyInput): Promise<void> {
    const input = parse(policySchema, raw);
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto("shared_compute_policies").values({
        owner_id: input.ownerId, period_id: input.periodId, starts_at: input.startsAt, ends_at: input.endsAt,
        allowance_ms: input.allowanceMs, held_ms: 0, settled_ms: 0,
      }).onConflict((oc) => oc.columns(["owner_id", "period_id"]).doNothing()).execute();
      const row = await trx.selectFrom("shared_compute_policies").selectAll()
        .where("owner_id", "=", input.ownerId).where("period_id", "=", input.periodId).forUpdate().executeTakeFirstOrThrow();
      if (row.starts_at !== input.startsAt || row.ends_at !== input.endsAt) throw new ComputeBudgetError("conflict");
      await trx.updateTable("shared_compute_policies").set({ allowance_ms: input.allowanceMs })
        .where("owner_id", "=", input.ownerId).where("period_id", "=", input.periodId).execute();
    });
  }
  async reserve(input: ComputeReserveInput): Promise<ComputeReservation> {
    // Validate before opening a transaction; the shared helper also validates its boundary.
    parse(reserveSchema, input);
    return this.db.transaction().execute((trx) => reserveComputeBudget(trx, input));
  }
  private async lockedReservation(trx: Transaction<ComputeBudgetDatabase>, ownerId: string, reservationId: string): Promise<ComputeReservationTable> {
    const found = await trx.selectFrom("shared_compute_reservations").select("period_id")
      .where("owner_id", "=", ownerId).where("reservation_id", "=", reservationId).executeTakeFirst();
    if (!found) throw new ComputeBudgetError("not_found");
    await trx.selectFrom("shared_compute_policies").select("owner_id")
      .where("owner_id", "=", ownerId).where("period_id", "=", found.period_id).forUpdate().executeTakeFirstOrThrow();
    return trx.selectFrom("shared_compute_reservations").selectAll()
      .where("owner_id", "=", ownerId).where("reservation_id", "=", reservationId).executeTakeFirstOrThrow();
  }
  /** Cancellation or a timeout is not proof that execution stopped: retain the full hold. */
  async markUncertain(raw: { ownerId: string; reservationId: string }): Promise<ComputeReservation> {
    const input = parse(reservationScopeSchema, raw);
    return this.db.transaction().execute(async (trx) => {
      const row = await this.lockedReservation(trx, input.ownerId, input.reservationId);
      if (row.state === "settled") return reservation(row);
      const updated = await trx.updateTable("shared_compute_reservations").set({ state: "uncertain" })
        .where("owner_id", "=", input.ownerId).where("reservation_id", "=", input.reservationId).returningAll().executeTakeFirstOrThrow();
      return reservation(updated);
    });
  }
  /** Call only after confirmed final termination. First settlement is immutable and
   * capped at the hold; later callbacks cannot reclaim credits or add a late debit.
   */
  async settle(raw: ComputeSettleInput): Promise<ComputeReservation> {
    const input = parse(settleSchema, raw);
    return this.db.transaction().execute(async (trx) => {
      const row = await this.lockedReservation(trx, input.ownerId, input.reservationId);
      if (row.state === "settled") return reservation(row);
      const actualMs = Math.min(input.actualMs, row.amount_ms);
      const updated = await trx.updateTable("shared_compute_reservations").set({ state: "settled", settled_ms: actualMs })
        .where("owner_id", "=", input.ownerId).where("reservation_id", "=", input.reservationId).returningAll().executeTakeFirstOrThrow();
      await trx.updateTable("shared_compute_policies").set({ held_ms: sql`held_ms - ${row.amount_ms}`, settled_ms: sql`settled_ms + ${actualMs}` })
        .where("owner_id", "=", input.ownerId).where("period_id", "=", row.period_id).execute();
      return reservation(updated);
    });
  }
  async snapshot(raw: { ownerId: string; periodId: string }): Promise<ComputeBudgetSnapshot | null> {
    const input = parse(scopeSchema, raw);
    const row = await this.db.selectFrom("shared_compute_policies").selectAll()
      .where("owner_id", "=", input.ownerId).where("period_id", "=", input.periodId).executeTakeFirst();
    return row ? { ownerId: row.owner_id, periodId: row.period_id, startsAt: row.starts_at, endsAt: row.ends_at,
      allowanceMs: row.allowance_ms, heldMs: row.held_ms, settledMs: row.settled_ms,
      availableMs: Math.max(0, row.allowance_ms - row.held_ms - row.settled_ms) } : null;
  }
}
