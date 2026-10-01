import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { CanonicalChatRunPolicySchema, CanonicalOwnerScopeSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatRequestIdSchema, CanonicalChatModelSelectionSchema, CanonicalProviderDriverKindSchema, type CanonicalChatApprovalDecision, type CanonicalOwnerScope } from "@matrix-os/contracts";
import { CanonicalOperationSchema, CanonicalActionIdSchema, type CanonicalOperation, type CanonicalExecutionPolicy } from "@matrix-os/contracts";
import { canonicalJsonStringify, normalizedArgumentDigest } from "./argument-digest.js";
import type { ChatDatabase } from "./database.js";
import type { ActionChatDatabase } from "./action-schema.js";
export interface ActionIdentity { owner: CanonicalOwnerScope; chatId: string; runId: string; actionId: string }
export interface ActionDecision extends ActionIdentity { argumentDigest: string; decision: CanonicalChatApprovalDecision; clientRequestId: string }
export class CanonicalActionError extends Error {
  constructor() { super("The canonical action is unavailable."); this.name = "CanonicalActionError"; }
}
type OperationPatch = Partial<Pick<CanonicalOperation, "state" | "claimToken" | "result" | "cancellationRequested">>;
const same = (a: unknown, b: unknown) => canonicalJsonStringify(a) === canonicalJsonStringify(b);
export class ActionRepository {
  readonly db: Kysely<ActionChatDatabase>;
  constructor(db: Kysely<ChatDatabase>) { this.db = db as unknown as Kysely<ActionChatDatabase>; }
  async verify(identity: Omit<ActionIdentity, "actionId">, policy?: CanonicalExecutionPolicy, db = this.db, allowTerminal = false): Promise<CanonicalExecutionPolicy> {
    CanonicalOwnerScopeSchema.parse(identity.owner);
    CanonicalChatIdSchema.parse(identity.chatId);
    CanonicalChatRunIdSchema.parse(identity.runId);
    let query = db.selectFrom("chat_runs").innerJoin("chats", "chats.id", "chat_runs.chat_id")
      .select(["chat_runs.run_policy", "chat_runs.status"]).where("chats.id", "=", identity.chatId)
      .where("chats.owner_type", "=", identity.owner.type).where("chats.owner_id", "=", identity.owner.ownerId)
      .where("chat_runs.id", "=", identity.runId);
    if (db.isTransaction) query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row || (!allowTerminal && !["accepted", "running", "waiting_for_approval", "waiting_for_input"].includes(row.status))) throw new CanonicalActionError();
    const parsed = CanonicalChatRunPolicySchema.safeParse(row.run_policy);
    const persisted = parsed.success ? parsed.data.executionPolicy : undefined;
    if (!persisted || (policy && !same(policy, persisted))) throw new CanonicalActionError();
    return persisted;
  }
  async qualificationInput(identity: ActionIdentity): Promise<import("./action-policy.js").ActionQualificationInput> {
    const policy = await this.verify(identity);
    const row = await this.db.selectFrom("chat_runs").select(["driver_kind", "selection", "permission_mode"]).where("id", "=", identity.runId).where("chat_id", "=", identity.chatId).executeTakeFirstOrThrow();
    return { driverKind: CanonicalProviderDriverKindSchema.parse(row.driver_kind), selection: CanonicalChatModelSelectionSchema.parse(row.selection), permissionMode: row.permission_mode, workspaceScope: policy.workspaceScope };
  }
  async get(identity: ActionIdentity, db = this.db): Promise<CanonicalOperation> {
    await this.verify(identity, undefined, db, true);
    const row = await db.selectFrom("chat_action_operations").select("operation").where("id", "=", identity.actionId)
      .where("chat_id", "=", identity.chatId).where("run_id", "=", identity.runId)
      .where("owner_type", "=", identity.owner.type).where("owner_id", "=", identity.owner.ownerId).executeTakeFirst();
    if (!row) throw new CanonicalActionError();
    return CanonicalOperationSchema.parse(row.operation);
  }
  async identityFor(input: { owner: CanonicalOwnerScope; chatId: string; actionId: string }): Promise<ActionIdentity> {
    CanonicalOwnerScopeSchema.parse(input.owner);
    CanonicalChatIdSchema.parse(input.chatId);
    const actionId = CanonicalActionIdSchema.parse(input.actionId);
    const row = await this.db.selectFrom("chat_action_operations").select("run_id")
      .where("id", "=", actionId).where("chat_id", "=", input.chatId)
      .where("owner_type", "=", input.owner.type).where("owner_id", "=", input.owner.ownerId)
      .executeTakeFirst();
    if (!row) throw new CanonicalActionError();
    return { ...input, actionId, runId: CanonicalChatRunIdSchema.parse(row.run_id) };
  }
  async listRecoverable(limit = 128): Promise<ActionIdentity[]> {
    const bounded = Math.max(1, Math.min(limit, 128));
    const rows = await this.db.selectFrom("chat_action_operations")
      .select(["id", "chat_id", "run_id", "owner_type", "owner_id"])
      .where("state", "in", ["running", "outcome_unknown"])
      .orderBy("id").limit(bounded).execute();
    return rows.map((row) => ({
      actionId: row.id,
      chatId: CanonicalChatIdSchema.parse(row.chat_id),
      runId: CanonicalChatRunIdSchema.parse(row.run_id),
      owner: CanonicalOwnerScopeSchema.parse({ type: row.owner_type, ownerId: row.owner_id }),
    }));
  }
  async propose(value: CanonicalOperation): Promise<CanonicalOperation> {
    const op = CanonicalOperationSchema.parse(value);
    if (normalizedArgumentDigest(op.arguments) !== op.argumentDigest) throw new CanonicalActionError();
    return this.db.transaction().execute(async (tx) => {
      await this.verify(op, op.executionPolicy, tx);
      if (!op.executionPolicy.tools.includes(op.toolId) || op.executionPolicy.actionMode === "conversation_only") throw new CanonicalActionError();
      await tx.insertInto("chat_action_operations").values({ id: op.id, chat_id: op.chatId, run_id: op.runId, owner_type: op.owner.type, owner_id: op.owner.ownerId, state: op.state, revision: op.revision, operation: op, decision_request_id: null, decision: null }).onConflict((c) => c.column("id").doNothing()).execute();
      const existing = await this.get({ ...op, actionId: op.id }, tx);
      for (const key of ["owner", "chatId", "runId", "executionPolicy", "toolId", "schemaRevision", "arguments", "argumentDigest"] as const) if (!same(op[key], existing[key])) throw new CanonicalActionError();
      return existing;
    });
  }
  async decide(input: ActionDecision): Promise<CanonicalOperation> {
    CanonicalChatRequestIdSchema.parse(input.clientRequestId);
    return this.db.transaction().execute(async (tx) => {
      const op = await this.get(input, tx);
      await this.verify(op, op.executionPolicy, tx);
      if (op.argumentDigest !== input.argumentDigest) throw new CanonicalActionError();
      const row = await tx.selectFrom("chat_action_operations").select(["decision_request_id", "decision"]).where("id", "=", op.id).executeTakeFirstOrThrow();
      if (row.decision_request_id === input.clientRequestId && row.decision === input.decision) return op;
      // Session-wide authorization is deliberately unsupported.
      if (input.decision === "approve_for_session" || op.state !== "waiting_for_approval") throw new CanonicalActionError();
      const next = this.next(op, { state: input.decision === "approve" ? "authorized" : "cancelled" });
      const result = await tx.updateTable("chat_action_operations").set({ operation: next, revision: next.revision, state: next.state, decision_request_id: input.clientRequestId, decision: input.decision }).where("id", "=", op.id).where("revision", "=", op.revision).where("state", "=", op.state).returning("id").executeTakeFirst();
      if (!result) throw new CanonicalActionError();
      return next;
    });
  }
  next(op: CanonicalOperation, patch: OperationPatch): CanonicalOperation {
    if (Object.keys(patch).some((key) => !["state", "claimToken", "result", "cancellationRequested"].includes(key))) throw new CanonicalActionError();
    return CanonicalOperationSchema.parse({ ...op, ...patch, revision: op.revision + 1, updatedAt: new Date().toISOString() });
  }
  async claim(op: CanonicalOperation): Promise<CanonicalOperation | null> {
    return this.db.transaction().execute(async (tx) => {
      await this.verify(op, op.executionPolicy, tx);
      const persisted = await this.get({ ...op, actionId: op.id }, tx);
      if (!same(persisted, op) || op.state !== "authorized" || op.cancellationRequested) return null;
      const next = this.next(op, { state: "running", claimToken: `claim_${randomUUID()}` });
      const result = await tx.updateTable("chat_action_operations").set({ operation: next, revision: next.revision, state: next.state }).where("id", "=", op.id).where("revision", "=", op.revision).where("state", "=", "authorized").returning("id").executeTakeFirst();
      return result ? next : null;
    });
  }
  /**
   * CAS write that reports whether the caller's own patch landed. `null` means
   * a concurrent write won the race — the row moved without this patch.
   */
  async tryTransition(op: CanonicalOperation, patch: OperationPatch): Promise<CanonicalOperation | null> {
    const next = this.next(op, patch);
    const result = await this.db.updateTable("chat_action_operations").set({ operation: next, revision: next.revision, state: next.state }).where("id", "=", op.id).where("revision", "=", op.revision).where("state", "=", op.state).returning("id").executeTakeFirst();
    return result ? next : null;
  }
  async transition(op: CanonicalOperation, patch: OperationPatch): Promise<CanonicalOperation> {
    return await this.tryTransition(op, patch) ?? this.get({ ...op, actionId: op.id });
  }
}
