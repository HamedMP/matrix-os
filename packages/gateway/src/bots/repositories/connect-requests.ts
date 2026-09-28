/**
 * Connect requests (`bot_connect_requests`). When a bot needs an account the
 * person has not connected, the gateway records the service's connection IDs
 * at request time. Reconciliation compares the live inventory with that
 * baseline: exactly one new connection completes the request, more than one
 * is ambiguous (the caller then asks which account), and none by expiry
 * expires it. Each outcome is claimed once, at the row's revision.
 */
import { sql, type Selectable } from "kysely";
import type { BotConnectRequestsTable } from "../database.js";
import { BotStateError, isoTimestamp, newBotStateId, toSafeInteger, withTransaction, type BotExecutor } from "./shared.js";

const MAX_CONNECTIONS = 64;
const MAX_LIFETIME_MS = 15 * 60_000;
const MAX_PENDING_LISTED = 64;
const CONNECTION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export interface BotConnectRequest {
  requestId: string;
  ownerId: string;
  interactionId: string;
  service: string;
  requestedAt: string;
  expiresAt: string;
  baselineConnectionIds: string[];
  status: BotConnectRequestsTable["status"];
  completedConnectionId: string | null;
  revision: number;
}

export type BotConnectOutcome =
  | { status: "pending" }
  | { status: "completed"; connectionId: string }
  | { status: "ambiguous"; connectionIds: string[] }
  | { status: "expired" };

function fromRow(row: Selectable<BotConnectRequestsTable>): BotConnectRequest {
  const baseline = typeof row.baseline_connection_ids === "string"
    ? JSON.parse(row.baseline_connection_ids) as string[]
    : row.baseline_connection_ids;
  return {
    requestId: row.request_id,
    ownerId: row.owner_id,
    interactionId: row.interaction_id,
    service: row.service,
    requestedAt: isoTimestamp(row.requested_at),
    expiresAt: isoTimestamp(row.expires_at),
    baselineConnectionIds: baseline,
    status: row.status,
    completedConnectionId: row.completed_connection_id,
    revision: toSafeInteger(row.revision),
  };
}

function connectionIds(values: readonly string[]): string[] {
  const unique = [...new Set(values)];
  if (unique.length > MAX_CONNECTIONS || unique.some((value) => !CONNECTION_ID.test(value))) {
    throw new BotStateError("invalid_input");
  }
  return unique.sort();
}

/** Pure outcome of comparing the live inventory with the baseline. */
export function connectOutcome(request: Pick<BotConnectRequest, "baselineConnectionIds" | "expiresAt">, current: readonly string[], now: string): BotConnectOutcome {
  const added = connectionIds(current).filter((id) => !request.baselineConnectionIds.includes(id));
  // Expiry wins: a connection that appears after the deadline does not complete the request.
  if (Date.parse(now) >= Date.parse(request.expiresAt)) return { status: "expired" };
  if (added.length === 1) return { status: "completed", connectionId: added[0]! };
  if (added.length > 1) return { status: "ambiguous", connectionIds: added };
  return { status: "pending" };
}

export function createBotConnectRequestsRepository(db: BotExecutor) {
  async function get(input: { ownerId: string; requestId: string }, executor: BotExecutor = db): Promise<BotConnectRequest | undefined> {
    const row = await executor.selectFrom("bot_connect_requests").selectAll()
      .where("owner_id", "=", input.ownerId).where("request_id", "=", input.requestId)
      .executeTakeFirst();
    return row ? fromRow(row) : undefined;
  }

  return {
    get,
    /** One request per interaction; call in the transaction that creates the interaction. */
    async create(input: {
      ownerId: string;
      interactionId: string;
      service: string;
      baselineConnectionIds: readonly string[];
      expiresAt: string;
      now: string;
    }, executor: BotExecutor = db): Promise<BotConnectRequest> {
      const lifetime = Date.parse(input.expiresAt) - Date.parse(input.now);
      if (!(lifetime > 0) || lifetime > MAX_LIFETIME_MS) throw new BotStateError("invalid_input");
      const row = await executor.insertInto("bot_connect_requests").values({
        request_id: newBotStateId("cr"),
        owner_id: input.ownerId,
        interaction_id: input.interactionId,
        service: input.service,
        requested_at: input.now,
        expires_at: input.expiresAt,
        baseline_connection_ids: JSON.stringify(connectionIds(input.baselineConnectionIds)),
        status: "pending",
        completed_connection_id: null,
        updated_at: input.now,
      }).returningAll().executeTakeFirstOrThrow();
      return fromRow(row);
    },
    /**
     * Applies the reconciliation outcome at `baseRevision`. A still-pending
     * outcome changes nothing. The row is locked while the outcome is
     * computed and written, in one transaction. Returns the recorded outcome.
     */
    async reconcile(input: {
      ownerId: string;
      requestId: string;
      baseRevision: number;
      currentConnectionIds: readonly string[];
      now: string;
    }, executor: BotExecutor = db): Promise<{ request: BotConnectRequest; outcome: BotConnectOutcome }> {
      return withTransaction(executor, async (trx) => {
        const locked = await trx.selectFrom("bot_connect_requests").selectAll()
          .where("owner_id", "=", input.ownerId).where("request_id", "=", input.requestId)
          .forUpdate()
          .executeTakeFirst();
        if (!locked) throw new BotStateError("not_found");
        const current = fromRow(locked);
        if (current.status !== "pending") throw new BotStateError("invalid_transition");
        if (current.revision !== input.baseRevision) throw new BotStateError("revision_conflict");
        const outcome = connectOutcome(current, input.currentConnectionIds, input.now);
        if (outcome.status === "pending") return { request: current, outcome };
        const row = await trx.updateTable("bot_connect_requests")
          .set({
            status: outcome.status,
            completed_connection_id: outcome.status === "completed" ? outcome.connectionId : null,
            revision: sql<number>`revision + 1`,
            updated_at: input.now,
          })
          .where("owner_id", "=", input.ownerId).where("request_id", "=", input.requestId)
          .where("status", "=", "pending").where("revision", "=", input.baseRevision)
          .where((eb) => (outcome.status === "expired" ? eb("expires_at", "<=", input.now) : eb("expires_at", ">", input.now)))
          .returningAll()
          .executeTakeFirst();
        if (!row) throw new BotStateError("revision_conflict");
        return { request: fromRow(row), outcome };
      });
    },
    async cancel(input: { ownerId: string; requestId: string; now: string }, executor: BotExecutor = db): Promise<boolean> {
      const row = await executor.updateTable("bot_connect_requests")
        .set({ status: "cancelled", revision: sql<number>`revision + 1`, updated_at: input.now })
        .where("owner_id", "=", input.ownerId).where("request_id", "=", input.requestId).where("status", "=", "pending")
        .returning("request_id")
        .executeTakeFirst();
      return row !== undefined;
    },
    async listPending(input: { ownerId: string; limit?: number }, executor: BotExecutor = db): Promise<BotConnectRequest[]> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? MAX_PENDING_LISTED), MAX_PENDING_LISTED));
      const rows = await executor.selectFrom("bot_connect_requests").selectAll()
        .where("owner_id", "=", input.ownerId).where("status", "=", "pending")
        .orderBy("requested_at", "asc").limit(limit)
        .execute();
      return rows.map(fromRow);
    },
  };
}

export type BotConnectRequestsRepository = ReturnType<typeof createBotConnectRequestsRepository>;
