import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Kysely, Selectable, Transaction } from "kysely";
import { z } from "zod/v4";
import { RoutineCliOperationSchema, type RoutineCliAction, type RoutineCliOperation } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import { RoutineCliError, routineCliBoundary } from "./routine-cli-errors.js";
import { lockRoutineCliControl } from "./routine-cli-lock-order.js";
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
type CapabilityRecord = Selectable<OwnerBotDatabase["routine_cli_capabilities"]>;
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
  /** Reconstructed ONLY by validateAcceptedWithin after consumed-capability checks; never issue/consume or public/native input. */
  readonly accepted?: true;
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
  validateLifecycle?: (source: RoutineCliSourceContext, trx: Transaction<OwnerBotDatabase>, requiredAction?: RoutineCliAction, invocation?: RoutineCliVerifiedInvocation) => Promise<boolean>;
  /** Exact current owner/action policy, including verified operation approval where required.
   * A remembered target, generic owner principal, harness label or injected actions list never suffices.
   * Retain required policy/lifecycle row gates through this transaction in the documented lock order.
   * Both callbacks must perform only bounded local/DB checks, no network/model/cancellation work. */
  /** Issuance-only target gate, after source locks. Consumption uses RequestService target lock order. */
  authorizeIssueTarget?: (source: RoutineCliSourceContext, operation: RoutineCliOperation, trx: Transaction<OwnerBotDatabase>, invocation: RoutineCliVerifiedInvocation) => Promise<boolean>;
  authorizeOperation?: (source: RoutineCliSourceContext, operation: RoutineCliOperation, trx: Transaction<OwnerBotDatabase>, invocation: RoutineCliVerifiedInvocation) => Promise<boolean>;
}

/** Internal registry only. No endpoint or native lifecycle/action-approval implementation is installed here.
 * Lock order: control routine (consume/accepted work) -> optional scope admission gate -> source generation gate -> source row
 * -> capability row -> actual host policy preference/owner gates -> producer Chat/Run/Task -> target locks.
 * Revocation takes only the source gate; it never requests the earlier control or later policy gates.
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
  const requireLifecycle = async (source: RoutineCliSourceContext, trx: Transaction<OwnerBotDatabase>, action?: RoutineCliAction, invocation?: RoutineCliVerifiedInvocation) => {
    requireTime(source);
    if (await deps.validateLifecycle!(source, trx, action, invocation) !== true) throw new RoutineCliError("permission_denied");
    requireTime(source);
  };
  const liveRecord = async (record: SourceRecord | undefined, trx: Transaction<OwnerBotDatabase>, action?: RoutineCliAction,
    operation?: RoutineCliOperation, invocation?: RoutineCliVerifiedInvocation): Promise<RoutineCliSourceContext> => {
    if (!record || record.revoked_at !== null) throw new RoutineCliError("permission_denied");
    const source = scopedContext(record.source_context);
    if (sourceId(source) !== record.source_id || sourceKey(source) !== record.source_key || !sameHash(contextHash(source), record.context_hash))
      throw new RoutineCliError("permission_denied");
    if (action && !source.actions.includes(action)) throw new RoutineCliError("permission_denied");
    await requireLifecycle(source, trx, action, invocation);
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
    /** Invocation-local secret cleanup. Preserve consumed tombstones and accepted exact decisions. */
    releaseInvocation: (reference: RoutineCliSourceReference, invocationId: string): Promise<{ consumed: boolean }> => routineCliBoundary(() => deps.db.transaction().execute(async trx => {
      const record = await lockReference(trx, reference), { scope } = configured();
      const cap = await trx.selectFrom("routine_cli_capabilities").select(["consumed_at"]).where("source_id", "=", record.source_id)
        .where("invocation_id", "=", z.uuid().parse(invocationId)).forUpdate().executeTakeFirst();
      if (cap?.consumed_at) return { consumed: true };
      await trx.updateTable("routine_cli_capabilities").set({ token_hash: null }).where("owner_id", "=", scope.ownerId)
        .where("computer_id", "=", scope.computerId).where("source_id", "=", record.source_id).where("invocation_id", "=", invocationId)
        .where("consumed_at", "is", null).execute();
      return { consumed: false };
    })),
    /** Private handoff check against an ALREADY consumed host invocation, not token reuse/issuance.
     * Token expiry/cleanup is irrelevant; original source expiry/revoke/action policy still fences claim.
     * Retain this gate through the real task/run claim and propagate rejection out of its transaction. */
    validateAcceptedWithin: <T>(trx: Transaction<OwnerBotDatabase>, input: { source: RoutineCliSourceContext; invocation: RoutineCliVerifiedInvocation; operation: RoutineCliOperation }, work: () => Promise<T>): Promise<T> => routineCliBoundary(async () => {
      const source = scopedContext(input.source), operation = RoutineCliOperationSchema.parse(input.operation);
      const reference = RefSchema.parse({ sourceId: input.invocation.sourceId });
      await lockRoutineCliControl(trx, configured().scope, operation);
      const record = await lockReference(trx, reference), digest = hash(JSON.stringify(operation));
      if (sourceId(source) !== reference.sourceId || !sameHash(contextHash(source), record.context_hash)
        || !sameHash(input.invocation.operationDigest, digest)) throw new RoutineCliError("permission_denied");
      const cap = await trx.selectFrom("routine_cli_capabilities").selectAll().where("owner_id", "=", source.ownerId)
        .where("computer_id", "=", source.computerId).where("source_id", "=", reference.sourceId)
        .where("invocation_id", "=", z.uuid().parse(input.invocation.invocationId)).forUpdate().executeTakeFirst();
      if (!cap?.consumed_at || !sameHash(cap.operation_digest, digest)) throw new RoutineCliError("permission_denied");
      const verified = Object.freeze({ sourceId: record.source_id, invocationId: cap.invocation_id, operationDigest: cap.operation_digest, accepted: true as const });
      await liveRecord(record, trx, actionFor(operation), operation, verified);
      const result = await work();
      await liveRecord(record, trx, actionFor(operation), operation, verified);
      return result;
    }),
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
        if (deps.authorizeIssueTarget && await deps.authorizeIssueTarget(source, operation, trx, verified) !== true) throw new RoutineCliError("permission_denied");
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
        await liveRecord(record, trx, actionFor(operation), operation, verified);
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
      const operation = input.operation, action = actionFor(operation), tokenHash = hash(input.token);
      const requireCapability = (cap: CapabilityRecord | undefined) => {
        if (!cap || !cap.token_hash || cap.consumed_at !== null || new Date(cap.expires_at).getTime() <= now().getTime()
          || !sameHash(tokenHash, cap.token_hash) || !sameHash(cap.operation_digest, hash(JSON.stringify(operation))))
          throw new RoutineCliError("permission_denied");
      };
      const found = await repo.capability(scope, tokenHash, trx);
      requireCapability(found); // Reject invalid/replayed/mismatched bearers before requesting any routine lock.
      if (!found) throw new RoutineCliError("permission_denied");
      await lockRoutineCliControl(trx, scope, operation);
      const record = await lockReference(trx, { sourceId: found.source_id });
      const cap = await repo.capability(scope, tokenHash, trx, true);
      requireCapability(cap); // Recheck under the original source-generation/capability locks.
      if (!cap) throw new RoutineCliError("permission_denied");
      const verified = Object.freeze({ sourceId: record.source_id, invocationId: cap.invocation_id, operationDigest: cap.operation_digest });
      const source = await liveRecord(record, trx, action, operation, verified);
      await repo.consume(scope, tokenHash, now().toISOString(), trx);
      const result = await work(source, trx, verified);
      // Validate again around awaited local admission work, including action policy and expiry.
      requireCapability(cap);
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
