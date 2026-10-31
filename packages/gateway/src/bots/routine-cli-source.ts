import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import { z } from "zod/v4";
import { RoutineCliOperationSchema, type RoutineCliAction, type RoutineCliOperation } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import { RoutineCliError, routineCliBoundary } from "./routine-cli-errors.js";
import { RoutineCliSourceContextSchema, type RoutineCliSourceContext } from "./routine-cli-source-context.js";
import { RoutineCliScopeSchema, type RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { createRoutineCliSourcesRepository, lockRoutineCliSourceAdmission, lockRoutineCliSourceGeneration } from "./repositories/routine-cli-sources.js";

const RefSchema = z.object({ sourceId: z.string().regex(/^rsrc_[a-f0-9]{64}$/) }).strict();
export type RoutineCliSourceReference = z.infer<typeof RefSchema>;
// PostgreSQL UUID storage returns lowercase; policy must see that same host identity at issue and consume.
const IssueSchema = z.object({ invocationId: z.uuid().transform(value => value.toLowerCase()), operation: RoutineCliOperationSchema }).strict();
const ConsumeSchema = z.object({ token: z.string().max(128).optional(), operation: RoutineCliOperationSchema }).strict();
const LimitsSchema = z.object({
  maxActiveSources: z.number().int().min(1).max(256).default(256),
  maxCapabilitiesPerSource: z.number().int().min(1).max(32).default(32),
  maxCapabilitiesPerScope: z.number().int().min(1).max(1024).default(1024),
  capabilityTtlMs: z.number().int().min(1).max(120_000).default(60_000),
  cleanupBatchSize: z.number().int().min(1).max(1000).default(100),
}).strict();
type SourceRecord = Selectable<OwnerBotDatabase["routine_cli_sources"]>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sameHash = (left: string, right: string) => /^[a-f0-9]{64}$/.test(left) && /^[a-f0-9]{64}$/.test(right)
  && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
const sourceKey = (source: RoutineCliSourceContext) => hash(JSON.stringify([source.ownerId, source.computerId, source.harness, source.identity]));
const sourceId = (source: RoutineCliSourceContext) => `rsrc_${hash(JSON.stringify([sourceKey(source), source.generation]))}`;
const contextHash = (source: RoutineCliSourceContext) => hash(JSON.stringify(source));
const actionFor = (operation: RoutineCliOperation): RoutineCliAction => operation.operation === "propose" ? "propose"
  : ["list", "show", "request"].includes(operation.operation) ? "read" : "control";

/** Private one-shot handoff to a future fixed CLI child. JSON/inspection expose no token.
 * Deliver only after issue() has committed, never via argv, shared env, config or logs. */
export class RoutineCliCapabilityDelivery {
  #token: string | undefined;
  constructor(token: string, readonly expiresAt: string) { this.#token = token; }
  takeToken(): string {
    const token = this.#token;
    if (!token) throw new RoutineCliError("permission_denied");
    this.#token = undefined;
    return token;
  }
  toJSON(): { expiresAt: string } { return { expiresAt: this.expiresAt }; }
}
/** Verified host-only identity from issuance input or the locked stored capability; never CLI body data. */
export interface RoutineCliVerifiedInvocation {
  readonly sourceId: string;
  readonly invocationId: string;
  readonly operationDigest: string;
}
export interface RoutineCliSourceDependencies {
  db: Kysely<OwnerBotDatabase>;
  scope: RoutineCliScope;
  now?: () => Date;
  limits?: Partial<z.infer<typeof LimitsSchema>>;
  /** Host-owned lifecycle facts. This callback is an integration seam, not source admission.
   * It must check exact current native turn/launch incarnation/generation, personal private policy and current action ceilings. */
  validateLifecycle?: (source: RoutineCliSourceContext, trx: Transaction<OwnerBotDatabase>, requiredAction?: RoutineCliAction) => Promise<boolean>;
  /** Exact current owner/action policy, including verified operation approval where required.
   * A remembered target, generic owner principal, harness label or injected actions list never suffices.
   * Retain required policy/lifecycle row gates through this transaction in the documented lock order.
   * Both callbacks must perform only bounded local/DB checks, no network/model/cancellation work. */
  authorizeOperation?: (source: RoutineCliSourceContext, operation: RoutineCliOperation, trx: Transaction<OwnerBotDatabase>, invocation: RoutineCliVerifiedInvocation) => Promise<boolean>;
}

/** Internal registry only. No endpoint or native lifecycle/action-approval implementation is installed here.
 * Lock order: optional scope admission gate -> source lifecycle/generation gate -> source row -> capability row
 * -> caller's target preference/definition/Chat/binding locks. Revocation takes the same source gate.
 * Register/issue must never run inside a callback that already owns downstream target locks. */
export function createRoutineCliSourceService(deps: RoutineCliSourceDependencies) {
  const repo = createRoutineCliSourcesRepository(deps.db);
  const configured = () => {
    const scope = RoutineCliScopeSchema.safeParse(deps.scope), limits = LimitsSchema.safeParse(deps.limits ?? {});
    if (!scope.success || !limits.success || !deps.validateLifecycle || !deps.authorizeOperation) throw new RoutineCliError("unavailable");
    return { scope: scope.data, limits: limits.data };
  };
  const now = () => {
    const value = deps.now?.() ?? new Date();
    if (!Number.isFinite(value.getTime())) throw new RoutineCliError("unavailable");
    return value;
  };
  const requireTime = (source: RoutineCliSourceContext) => {
    const current = now().getTime();
    if (Date.parse(source.issuedAt) > current || Date.parse(source.expiresAt) <= current
      || Date.parse(source.expiresAt) <= Date.parse(source.issuedAt)) throw new RoutineCliError("permission_denied");
  };
  const scopedContext = (value: RoutineCliSourceContext): RoutineCliSourceContext => {
    const source = RoutineCliSourceContextSchema.parse(value), { scope } = configured();
    if (source.ownerId !== scope.ownerId || source.computerId !== scope.computerId) throw new RoutineCliError("permission_denied");
    requireTime(source);
    return source;
  };
  const requireLifecycle = async (source: RoutineCliSourceContext, trx: Transaction<OwnerBotDatabase>, action?: RoutineCliAction) => {
    requireTime(source);
    if (await deps.validateLifecycle!(source, trx, action) !== true) throw new RoutineCliError("permission_denied");
    requireTime(source);
  };
  const liveRecord = async (record: SourceRecord | undefined, trx: Transaction<OwnerBotDatabase>, action?: RoutineCliAction,
    operation?: RoutineCliOperation, invocation?: RoutineCliVerifiedInvocation): Promise<RoutineCliSourceContext> => {
    if (!record || record.revoked_at !== null) throw new RoutineCliError("permission_denied");
    const source = scopedContext(record.source_context);
    if (sourceId(source) !== record.source_id || sourceKey(source) !== record.source_key || !sameHash(contextHash(source), record.context_hash))
      throw new RoutineCliError("permission_denied");
    if (action && !source.actions.includes(action)) throw new RoutineCliError("permission_denied");
    await requireLifecycle(source, trx, action);
    if (operation) {
      if (!invocation) throw new RoutineCliError("unavailable");
      if (await deps.authorizeOperation!(source, operation, trx, invocation) !== true) throw new RoutineCliError("permission_denied");
    }
    requireTime(source);
    return source;
  };
  const lockReference = async (trx: Transaction<OwnerBotDatabase>, reference: RoutineCliSourceReference): Promise<SourceRecord> => {
    if (!trx.isTransaction) throw new RoutineCliError("unavailable");
    const { scope } = configured();
    const first = await repo.source(scope, RefSchema.parse(reference).sourceId, trx);
    if (!first) throw new RoutineCliError("permission_denied");
    await lockRoutineCliSourceGeneration(trx, scope, first.source_key);
    const current = await repo.source(scope, first.source_id, trx, true);
    if (!current) throw new RoutineCliError("permission_denied");
    return current;
  };
  const registerWithin = (trx: Transaction<OwnerBotDatabase>, value: RoutineCliSourceContext): Promise<RoutineCliSourceReference> => routineCliBoundary(async () => {
    if (!trx.isTransaction) throw new RoutineCliError("unavailable");
    const source = scopedContext(value), { scope, limits } = configured(), key = sourceKey(source), id = sourceId(source);
    await lockRoutineCliSourceAdmission(trx, scope);
    await lockRoutineCliSourceGeneration(trx, scope, key);
    await requireLifecycle(source, trx);
    const existing = await repo.source(scope, id, trx, true);
    if (existing) {
      if (existing.revoked_at !== null) throw new RoutineCliError("permission_denied");
      if (!sameHash(existing.context_hash, contextHash(source))) throw new RoutineCliError("revision_conflict");
      return { sourceId: id };
    }
    if (await repo.activeSources(scope, now().toISOString(), key, trx) >= limits.maxActiveSources) throw new RoutineCliError("unavailable");
    await repo.register({ source_id: id, owner_id: source.ownerId, computer_id: source.computerId, source_key: key,
      generation: source.generation, context_hash: contextHash(source), source_context: source,
      issued_at: source.issuedAt, expires_at: source.expiresAt, revoked_at: null }, trx, now().toISOString());
    return { sourceId: id };
  });
  const revokeWithin = (trx: Transaction<OwnerBotDatabase>, reference: RoutineCliSourceReference): Promise<{ revoked: true }> => routineCliBoundary(async () => {
    const record = await lockReference(trx, reference);
    await repo.revoke(configured().scope, record.source_id, now().toISOString(), trx);
    return { revoked: true };
  });
  /** Task1 callback: retain the generation gate and check current source/action ceilings.
   * This is not exact-operation authorization or bearer consumption; dispatch must use consumeWithin. */
  const revalidateSource = (value: RoutineCliSourceContext, action: RoutineCliAction, trx: Transaction<OwnerBotDatabase>): Promise<boolean> => routineCliBoundary(async () => {
    try {
      const source = scopedContext(value), record = await lockReference(trx, { sourceId: sourceId(source) });
      if (!sameHash(record.context_hash, contextHash(source))) return false;
      await liveRecord(record, trx, action);
      return true;
    } catch (error: unknown) {
      if (error instanceof RoutineCliError && error.code === "permission_denied") return false;
      throw error;
    }
  });
  return {
    registerWithin,
    register: (source: RoutineCliSourceContext) => routineCliBoundary(() => deps.db.transaction().execute(trx => registerWithin(trx, source))),
    revokeWithin,
    revoke: (reference: RoutineCliSourceReference) => routineCliBoundary(() => deps.db.transaction().execute(trx => revokeWithin(trx, reference))),
    revalidateSource,
    issue: (reference: RoutineCliSourceReference, value: z.infer<typeof IssueSchema>): Promise<RoutineCliCapabilityDelivery> => routineCliBoundary(async () => {
      const input = IssueSchema.parse(value), operation = input.operation, { scope, limits } = configured();
      return deps.db.transaction().execute(async trx => {
        await lockRoutineCliSourceAdmission(trx, scope);
        const record = await lockReference(trx, reference);
        const verified = Object.freeze({ sourceId: record.source_id, invocationId: input.invocationId, operationDigest: hash(JSON.stringify(operation)) });
        const source = await liveRecord(record, trx, actionFor(operation), operation, verified), current = now();
        if (await repo.activeCapabilities(scope, current.toISOString(), record.source_id, trx) >= limits.maxCapabilitiesPerSource
          || await repo.activeCapabilities(scope, current.toISOString(), undefined, trx) >= limits.maxCapabilitiesPerScope)
          throw new RoutineCliError("unavailable");
        const token = `rcli_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(Math.min(current.getTime() + limits.capabilityTtlMs, Date.parse(source.expiresAt))).toISOString();
        await repo.issue({ source_id: record.source_id, owner_id: scope.ownerId, computer_id: scope.computerId,
          invocation_id: verified.invocationId, operation_digest: verified.operationDigest, token_hash: hash(token),
          issued_at: current.toISOString(), expires_at: expiresAt, consumed_at: null }, trx);
        // Admission-triggered bounded cleanup; SKIP LOCKED never waits for another consumer's capability.
        await repo.cleanup(scope, now().toISOString(), limits.cleanupBatchSize, trx);
        requireTime(source);
        if (Date.parse(expiresAt) <= now().getTime()) throw new RoutineCliError("permission_denied");
        return new RoutineCliCapabilityDelivery(token, expiresAt);
      });
    }),
    /** Only atomic DB admission/receipt work belongs in work(); external effects follow durable commit.
     * Caller must propagate rejection out of its transaction to roll back consumption and DB work;
     * catching and committing here would retain partial admission. No reusable bearer escapes this gate.
     * Reconciliation uses a fresh host invocation capability and its existing durable request ID. */
    consumeWithin: <T>(trx: Transaction<OwnerBotDatabase>, value: z.infer<typeof ConsumeSchema>,
      work: (source: RoutineCliSourceContext, executor: Transaction<OwnerBotDatabase>, invocation: RoutineCliVerifiedInvocation) => Promise<T>): Promise<T> => routineCliBoundary(async () => {
      if (!trx.isTransaction) throw new RoutineCliError("unavailable");
      const input = ConsumeSchema.parse(value), { scope } = configured();
      if (input.token === undefined) throw new RoutineCliError("source_context_required");
      if (!/^rcli_[A-Za-z0-9_-]{43}$/.test(input.token)) throw new RoutineCliError("permission_denied");
      const tokenHash = hash(input.token), found = await repo.capability(scope, tokenHash, trx);
      if (!found) throw new RoutineCliError("permission_denied");
      const record = await lockReference(trx, { sourceId: found.source_id });
      const cap = await repo.capability(scope, tokenHash, trx, true), operation = input.operation, action = actionFor(operation);
      const requireCapability = () => {
        if (!cap || !cap.token_hash || cap.consumed_at !== null || new Date(cap.expires_at).getTime() <= now().getTime()
          || !sameHash(tokenHash, cap.token_hash) || !sameHash(cap.operation_digest, hash(JSON.stringify(operation))))
          throw new RoutineCliError("permission_denied");
      };
      requireCapability();
      if (!cap) throw new RoutineCliError("permission_denied");
      const verified = Object.freeze({ sourceId: record.source_id, invocationId: cap.invocation_id, operationDigest: cap.operation_digest });
      const source = await liveRecord(record, trx, action, operation, verified);
      await repo.consume(scope, tokenHash, now().toISOString(), trx);
      const result = await work(source, trx, verified);
      // Validate again around awaited local admission work, including action policy and expiry.
      requireCapability();
      await liveRecord(record, trx, action, operation, verified);
      return result;
    }),
    cleanup: () => routineCliBoundary(async () => {
      const { scope, limits } = configured();
      return deps.db.transaction().execute(async trx => ({ deleted: await repo.cleanup(scope, now().toISOString(), limits.cleanupBatchSize, trx) }));
    }),
  };
}
export type RoutineCliSourceService = ReturnType<typeof createRoutineCliSourceService>;
