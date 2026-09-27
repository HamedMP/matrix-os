import { randomBytes } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { OwnerBotDatabase } from "../database.js";

/** Repositories accept the pool or a caller's transaction, so multi-table writes can share one. */
export type BotExecutor = Kysely<OwnerBotDatabase> | Transaction<OwnerBotDatabase>;

export type BotStateErrorCode =
  | "not_found"
  | "conflict"
  | "revision_conflict"
  | "invalid_transition"
  | "capacity_exceeded"
  | "too_large"
  | "invalid_input";

/** Typed repository failure; routes map codes to responses and never echo database detail. */
export class BotStateError extends Error {
  constructor(readonly code: BotStateErrorCode) {
    super(`Bot state operation failed: ${code}`);
    this.name = "BotStateError";
  }
}

/** Server-generated identifiers: a fixed prefix and 24 lowercase hex characters. */
export function newBotStateId(prefix: "bot" | "chat" | "task" | "ckpt" | "bses" | "in" | "cr" | "gr" | "mem"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

export function isoTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function optionalIsoTimestamp(value: Date | string | null): string | null {
  return value === null ? null : isoTimestamp(value);
}

/** BIGINT columns arrive as strings from `pg`; every value here is far below 2^53. */
export function toSafeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("Stored integer is out of range");
  return parsed;
}

/** Postgres unique-violation on a named index or constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "23505") return false;
  if (constraint === undefined) return true;
  return "constraint" in error && error.constraint === constraint;
}

/** Runs `work` in the caller's transaction, or opens one when given the pool. */
export async function withTransaction<T>(executor: BotExecutor, work: (trx: Transaction<OwnerBotDatabase>) => Promise<T>): Promise<T> {
  if (executor.isTransaction) return work(executor as Transaction<OwnerBotDatabase>);
  return executor.transaction().execute(work);
}
