import type { Kysely, Transaction } from "kysely";
import { z } from "zod/v4";
import { BotInteractionIdSchema, RoutineCliOperationSchema, RoutineCliReceiptSchema, RoutineCliResultSchema,
  type RoutineCliAction, type RoutineCliOperation, type RoutineCliResult } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { BotStateTransaction, BotStateTransactions } from "./events.js";
import type { RoutineCliSourceContext } from "./routine-cli-source-context.js";
import type { RoutineCliSourceService, RoutineCliVerifiedInvocation } from "./routine-cli-source.js";
import type { RoutineCliTargetService, RoutineCliResolvedTarget } from "./routine-cli-targets.js";
import { RoutineCliScopeSchema, type RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { createRoutineCliRequestsRepository, lockRoutineCliRequest, type RoutineCliRequestRecord } from "./repositories/routine-cli-requests.js";
import { createBotRoutinesRepository } from "./repositories/routines.js";
import { BotStateError } from "./repositories/shared.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import { createRoutineCliViews } from "./routine-cli-views.js";

export type RoutineCliMutationOperation = Extract<RoutineCliOperation, { operation: "propose" | "pause" | "resume" | "archive" }>;
const AdmissionSchema = z.discriminatedUnion("disposition", [
  z.object({ disposition: z.literal("queued") }).strict(),
  z.object({ disposition: z.literal("pending_approval"), interactionId: BotInteractionIdSchema }).strict(),
  RoutineCliReceiptSchema.options[2].pick({ disposition: true, routine: true }).strict(),
  z.object({ disposition: z.literal("unknown") }).strict(),
]);
export type RoutineCliAdmission = z.infer<typeof AdmissionSchema>;
export type RoutineCliMutationAdmission = (input: {
  transaction: BotStateTransaction; source: RoutineCliSourceContext; invocation: RoutineCliVerifiedInvocation;
  target: RoutineCliResolvedTarget; operation: RoutineCliMutationOperation;
}) => Promise<RoutineCliAdmission>;
export type RoutineCliAfterMutationCommit = (input: Readonly<{
  source: RoutineCliSourceContext; invocation: RoutineCliVerifiedInvocation; target: RoutineCliResolvedTarget;
  operation: RoutineCliMutationOperation; admission: RoutineCliAdmission;
}>) => Promise<void>;
type TargetIntent = { source: RoutineCliSourceContext; invocation: RoutineCliVerifiedInvocation; target: RoutineCliResolvedTarget; operation: RoutineCliOperation };
export interface RoutineCliRequestDependencies {
  db: Kysely<OwnerBotDatabase>; scope: RoutineCliScope;
  sources: Pick<RoutineCliSourceService, "consumeWithin">;
  targets: Pick<RoutineCliTargetService, "resolveWithin" | "validatePinnedWithin">;
  /** Canonical Chat outbox-aware outer transaction. No nested source/canonical transaction. */
  transact: BotStateTransactions;
  now?: () => Date;
  /** Mandatory current exact invocation/target action policy. Must retain policy gates in this transaction.
   * This injection is NOT an owner approval implementation; no digest/latest-approval fallback exists. */
  authorizeTarget?: (input: TargetIntent, transaction: BotStateTransaction) => Promise<boolean>;
  /** Atomic DB admission only; real canonical control/proposal wiring is a separate increment.
   * No external model/network/cancellation work, no fabricated task/run/binding or successful default. */
  admitMutation?: RoutineCliMutationAdmission;
  /** External effects only after confirmed owning commit for a NEW admission. No executor is retained.
   * Failure cannot undo the durable receipt. Duplicates/unknown commits never redrive this hook. */
  afterMutationCommit?: RoutineCliAfterMutationCommit;
}
const ExecuteSchema = z.object({ token: z.string().max(128).optional(), operation: RoutineCliOperationSchema }).strict();
const mutation = (operation: RoutineCliOperation): operation is RoutineCliMutationOperation => !["list", "show", "request"].includes(operation.operation);
const actionFor = (operation: RoutineCliOperation): RoutineCliAction => operation.operation === "propose" ? "propose" : mutation(operation) ? "control" : "read";
/** Only strict bounded JSON intent is traversed, never transactions/repositories or caller resources. */
export function freezeIntent<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeIntent(child);
    Object.freeze(value);
  }
  return value;
}
class InvalidAdmissionResult extends RoutineCliError { constructor() { super("unavailable"); } }
function mapKnownAdmissionError(error: unknown): never {
  if (error instanceof BotStateError) {
    if (error.code === "revision_conflict") throw new RoutineCliError("revision_conflict");
    if (error.code === "not_found") throw new RoutineCliError("not_found");
    if (["invalid_input", "invalid_transition", "conflict"].includes(error.code)) throw new RoutineCliError("invalid_input");
  }
  throw error;
}

/** Internal source-only domain service. Capability -> request gate -> routine (controls) -> target/policy
 * -> atomic DB admission/outbox/receipt. Source revoke never takes these downstream locks. */
export function createRoutineCliRequestService(deps: RoutineCliRequestDependencies) {
  const ledger = createRoutineCliRequestsRepository(deps.db);
  const validateAdmission = async (result: unknown, target: RoutineCliResolvedTarget, operation: RoutineCliMutationOperation,
    trx: Transaction<OwnerBotDatabase>): Promise<RoutineCliAdmission> => {
    const parsed = AdmissionSchema.safeParse(result);
    if (!parsed.success) throw new InvalidAdmissionResult();
    const admitted = parsed.data;
    if (admitted.disposition === "pending_approval") {
      if (operation.operation !== "propose") throw new InvalidAdmissionResult();
      const interaction = await trx.selectFrom("bot_interactions").select(["interaction_id", "expires_at"])
        .where("interaction_id", "=", admitted.interactionId).where("owner_id", "=", target.ownerId)
        .where("bot_id", "=", target.botId).where("chat_id", "=", target.chatId).where("kind", "=", "approval")
        .where("responder_actor_id", "=", target.ownerId).where("status", "=", "pending").executeTakeFirst();
      if (!interaction || new Date(interaction.expires_at).getTime() <= (deps.now?.() ?? new Date()).getTime()) throw new InvalidAdmissionResult();
    }
    if (admitted.disposition === "applied") {
      if (operation.operation === "propose") throw new InvalidAdmissionResult();
      const current = await createBotRoutinesRepository(trx).getForChat({ ...target, routineId: operation.routineId }, trx);
      const expected = operation.operation === "pause" ? "paused" : operation.operation === "resume" ? "active" : "archived";
      if (!current || admitted.routine.routineId !== operation.routineId || current.status !== expected
        || admitted.routine.status !== current.status || admitted.routine.revision !== current.revision
        || current.revision <= operation.baseRevision) throw new InvalidAdmissionResult();
    }
    return admitted;
  };
  return {
    async execute(raw: z.infer<typeof ExecuteSchema>): Promise<RoutineCliResult> {
      const parsed = ExecuteSchema.safeParse(raw), configured = RoutineCliScopeSchema.safeParse(deps.scope);
      if (!parsed.success) throw new RoutineCliError("invalid_input");
      const operation = freezeIntent(parsed.data.operation), mutating = mutation(operation);
      if (!configured.success || typeof deps.transact !== "function" || !deps.sources?.consumeWithin
        || !deps.targets?.resolveWithin || !deps.targets?.validatePinnedWithin || !deps.authorizeTarget
        || (mutating && !deps.admitMutation)) throw new RoutineCliError("unavailable");
      const scope = configured.data;
      let admissionStarted = false;
      let committedIntent: Parameters<RoutineCliAfterMutationCommit>[0] | undefined;
      try {
        const result = await deps.transact(scope.ownerId, async transaction => {
          if (!transaction.db.isTransaction) throw new RoutineCliError("unavailable");
          const trx = transaction.db as Transaction<OwnerBotDatabase>;
          // Any rejection must escape the outer transaction; never swallow failure and commit partial DB work.
          return deps.sources.consumeWithin(trx, parsed.data, async (source, _executor, invocation) => {
            freezeIntent(source);
            if (source.ownerId !== scope.ownerId || source.computerId !== scope.computerId) throw new RoutineCliError("permission_denied");
            const views = createRoutineCliViews(trx, deps.now), routines = createBotRoutinesRepository(trx), action = actionFor(operation);
            const requestId = "requestId" in operation ? operation.requestId : undefined;
            let existing: RoutineCliRequestRecord | undefined;
            if (requestId) {
              await lockRoutineCliRequest(trx, scope, requestId);
              existing = await ledger.get(scope, requestId, trx);
              if (mutating && existing && existing.operationDigest !== invocation.operationDigest) throw new RoutineCliError("request_conflict");
            }
            // Canonical scheduler/control order: routine before target Chat/definition/binding gates.
            if (mutating && operation.operation !== "propose") {
              if (!await routines.lock(scope.ownerId, operation.routineId, trx)) throw new RoutineCliError("not_found");
            }
            const target = freezeIntent(existing
              ? await deps.targets.validatePinnedWithin(trx, source, action, existing.target)
              : await deps.targets.resolveWithin(trx, source, action));
            if (await deps.authorizeTarget!(Object.freeze({ source, invocation, target, operation }), transaction) !== true) throw new RoutineCliError("permission_denied");
            if (existing) return views.receipt(existing);
            if (operation.operation === "list") return views.list(target);
            if (operation.operation === "show") return views.show(target, operation.routineId);
            if (operation.operation === "request") return { kind: "not_observed" as const, requestId: operation.requestId, mayStillArrive: true as const };
            if (operation.operation !== "propose" && !await routines.getForChat({ ...target, routineId: operation.routineId }, trx)) throw new RoutineCliError("not_found");
            let admitted: RoutineCliAdmission;
            admissionStarted = true;
            try { admitted = await deps.admitMutation!(Object.freeze({ transaction, source, invocation, target, operation })); }
            catch (error: unknown) { mapKnownAdmissionError(error); }
            const admission = await validateAdmission(admitted!, target, operation, trx);
            const record = await ledger.insert(scope, { requestId: operation.requestId, operationDigest: invocation.operationDigest,
              operation, source, invocation, target, admission, createdAt: (deps.now?.() ?? new Date()).toISOString() }, trx);
            committedIntent = freezeIntent({ source, invocation, target, operation, admission });
            return views.receipt(record);
          });
        });
        const safeResult = RoutineCliResultSchema.parse(result);
        if (committedIntent && deps.afterMutationCommit) {
          try { await deps.afterMutationCommit(committedIntent); }
          catch (error: unknown) {
            console.warn("[routine-cli-requests] Post-commit execution unconfirmed", error instanceof Error ? error.name : "UnknownError");
          }
        }
        return safeResult;
      } catch (error: unknown) {
        if (error instanceof InvalidAdmissionResult) throw new RoutineCliError("unavailable");
        if (error instanceof RoutineCliError && (error.code !== "unavailable" || !admissionStarted)) throw error;
        // A commit/connection acknowledgement can be lost after atomic admission actually committed.
        // Never auto-retry or claim definitely-unapplied. A later source-authorized request read reconciles it.
        if (mutating) return { kind: "unknown", requestId: operation.requestId, disposition: "unknown", reconcile: true };
        console.warn("[routine-cli-requests] Read unavailable", error instanceof Error ? error.name : "UnknownError");
        throw new RoutineCliError("unavailable");
      }
    },
  };
}
export type RoutineCliRequestService = ReturnType<typeof createRoutineCliRequestService>;
