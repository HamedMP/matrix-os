import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod/v4";
import type { Kysely, Transaction } from "kysely";
import {
  CanonicalChatIdSchema, RoutineFullAccessCreateChallengeSchema, RoutineFullAccessDecisionSubmitSchema,
  RoutineFullAccessIdSchema, RoutineFullAccessProofSchema, RoutineFullAccessRevokeSchema, RoutineFullAccessStatusSchema,
  routineFullAccessTurnRequestIdentity, type RoutineFullAccessDecisionSubmit, type RoutineFullAccessProof,
  type RoutineFullAccessStatus, type RoutineFullAccessTuple,
} from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatDatabase } from "../chat/database.js";
import { hasNonPrivateChatScope } from "../chat/private-routine-authority.js";
import type { RoutineFullAccessTurnAdmission } from "../chat/turn-admission.js";
import type { RoutineCliSourceContext } from "./routine-cli-source-context.js";
import type { RoutineCliRememberedTarget, RoutineCliTargetService } from "./routine-cli-targets.js";
import { RoutineCliScopeSchema, type RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { lockRoutineCliPolicyScope } from "./routine-cli-lock-order.js";
import { RoutineCliError, routineCliBoundary } from "./routine-cli-errors.js";

const MAX_LIFETIME = 30 * 60_000;
const actions = ["read", "propose", "control"] as const;
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
type Scope = { id: string; digest: string; revision: number; expiresAt: number; target: RoutineCliRememberedTarget;
  decision?: RoutineFullAccessDecisionSubmit };
type Entry = { chatId: string; revision: number; touchedAt: number; scope?: Scope };
type RunLease = { entry: Entry; scope: Scope; runId: string; turnId: string; controller: AbortController;
  principal: RequestPrincipal; source?: RoutineCliSourceContext; detach(): void };
/** Opaque host-only lease. No representation is serialized to a provider or accepted over HTTP. */
export interface RoutineFullAccessSourceLease {
  readonly target: RoutineCliRememberedTarget;
  readonly revision: number;
  current(): boolean;
  validateWithin(trx: Transaction<OwnerBotDatabase>): Promise<boolean>;
  release(): void;
}

/** Explicit consent and fresh Run admission are separate gates. Memory is bounded and never restored. */
export function createRoutineFullAccessService(options: {
  db: Kysely<OwnerBotDatabase>; scope: RoutineCliScope;
  targets: Pick<RoutineCliTargetService, "resolveOwnerDefaultWithin">;
  platform: { handle: string; machineId: string; runtimeSlot: string;
    verify(tuple: RoutineFullAccessTuple, proof: string): Promise<RoutineFullAccessProof> };
  now?: () => number; maxScopes?: number; maxRunLeases?: number;
}) {
  const configured = RoutineCliScopeSchema.parse(options.scope), now = options.now ?? Date.now;
  const maxScopes = options.maxScopes ?? 128, maxRunLeases = options.maxRunLeases ?? 256;
  if (!options.db?.transaction || !options.targets?.resolveOwnerDefaultWithin || !options.platform?.verify)
    throw new Error("Routine origin dependencies unavailable");
  if (!Number.isInteger(maxScopes) || maxScopes < 1 || maxScopes > 128
    || !Number.isInteger(maxRunLeases) || maxRunLeases < 1 || maxRunLeases > 256) throw new Error("Routine origin limits unavailable");
  const entries = new Map<string, Entry>(); // <=128 Chat scopes/challenges, including revoked tombstones.
  const leases = new Map<string, RunLease>(); // <=256 new accepted Runs, source-close/expiry/shutdown eviction.
  const nonces = new Map<string, number>(); // <=512 verified proofs, original <=60-second expiry only.
  let revision = 0, closed = false, verificationUnavailable = false;
  const nextRevision = () => ++revision;
  const owner = (principal: RequestPrincipal) => {
    const parsed = z.strictObject({ userId: RoutineCliScopeSchema.shape.ownerId,
      source: z.enum(["jwt", "platform-verified", "configured-container", "dev-default"]) }).safeParse(principal);
    if (closed || !parsed.success || parsed.data.userId !== configured.ownerId) throw new RoutineCliError("permission_denied");
    return parsed.data;
  };
  const release = (lease: RunLease) => {
    if (leases.get(lease.runId) !== lease) return;
    leases.delete(lease.runId); lease.detach(); lease.controller.abort();
  };
  const invalidate = (entry: Entry) => {
    for (const lease of leases.values()) if (lease.entry === entry) release(lease);
    entry.scope = undefined; entry.revision = nextRevision(); entry.touchedAt = now();
  };
  const scopeCurrent = (entry: Entry, scope: Scope) => !closed && entries.get(entry.chatId) === entry
    && entry.scope === scope && scope.expiresAt > now();
  const leaseCurrent = (lease: RunLease) => leases.get(lease.runId) === lease && !lease.controller.signal.aborted
    && scopeCurrent(lease.entry, lease.scope) && lease.scope.decision?.decision === "approve";
  const sweep = () => {
    for (const [nonce, expiresAt] of nonces) if (expiresAt <= now()) nonces.delete(nonce);
    for (const entry of entries.values()) {
      if (entry.scope && entry.scope.expiresAt <= now()) invalidate(entry);
      if (!entry.scope && now() - entry.touchedAt >= MAX_LIFETIME) entries.delete(entry.chatId);
    }
    for (const lease of leases.values()) if (!leaseCurrent(lease)) release(lease);
  };
  const timer = setInterval(sweep, 1000); timer.unref?.();
  const ordinaryWithin = async (trx: Transaction<OwnerBotDatabase>, chatId: string) => {
    await lockRoutineCliPolicyScope(trx, configured);
    // The Chat lock fences both live bindings and project publication. Read
    // the durable sharing scope without locking it after the Chat.
    const chat = await trx.selectFrom("chats").select("id").where("id", "=", chatId)
      .where("owner_id", "=", configured.ownerId).where("owner_type", "=", "personal")
      .where("lifecycle", "=", "active").where("collaboration", "is", null).forUpdate().executeTakeFirst();
    if (!chat || await hasNonPrivateChatScope(trx as unknown as Transaction<ChatDatabase>, { type: "personal", ownerId: configured.ownerId }, chatId)
      || await trx.selectFrom("bot_chat_bindings").select("bot_id").where("chat_id", "=", chatId)
        .where("removed_at", "is", null).limit(1).forUpdate().executeTakeFirst()) {
      const entry = entries.get(chatId);
      if (entry?.scope) invalidate(entry);
      throw new RoutineCliError("permission_denied");
    }
  };
  const inspect = async (principal: RequestPrincipal, chatId: string, pinned?: RoutineCliRememberedTarget, admission?: RoutineFullAccessTurnAdmission) => {
    owner(principal); CanonicalChatIdSchema.parse(chatId);
    return options.db.transaction().execute(async trx => {
      await ordinaryWithin(trx, chatId);
      if (admission) {
        const run = await trx.selectFrom("chat_runs").select(["selection", "context_snapshot"])
          .where("id", "=", admission.runId).where("chat_id", "=", chatId).where("turn_id", "=", admission.turnId)
          .where("client_request_id", "=", admission.clientRequestId).where("status", "=", "accepted")
          .where("attempt", "=", 1).where("driver_kind", "=", "claude_code").where("permission_mode", "=", "full_access")
          .where("interaction_mode", "=", "default").forShare().executeTakeFirst();
        const selection = typeof run?.selection === "string" ? JSON.parse(run.selection) : run?.selection;
        const context = typeof run?.context_snapshot === "string" ? JSON.parse(run.context_snapshot) : run?.context_snapshot;
        if (!run || !isDeepStrictEqual(selection, admission.run.selection)
          || context && typeof context === "object" && "agent" in context && context.agent) throw new RoutineCliError("permission_denied");
      }
      return options.targets.resolveOwnerDefaultWithin(trx, principal, pinned);
    });
  };
  const inspectScope = async (principal: RequestPrincipal, entry: Entry, scope: Scope) => {
    try { return await inspect(principal, entry.chatId, scope.target); }
    catch (error: unknown) {
      if (entry.scope === scope) invalidate(entry);
      throw error;
    }
  };
  const projection = (entry: Entry | undefined, eligibility: RoutineFullAccessStatus["eligibility"] = "eligible"): RoutineFullAccessStatus => {
    const scope = entry?.scope, current = entry && scope && scopeCurrent(entry, scope);
    const common = current ? { expiresAt: new Date(scope.expiresAt).toISOString(), policyRevision: scope.revision,
      actions, target: { botId: scope.target.botId, chatId: scope.target.chatId } } : undefined;
    return RoutineFullAccessStatusSchema.parse({ revision: entry?.revision ?? 0,
      eligibility: eligibility === "eligible" && verificationUnavailable ? "unavailable" : eligibility, origin: "browser_required",
      consent: common && scope?.decision?.decision === "approve" ? { ...common, scopeId: scope.id } : null,
      challenge: common && !scope?.decision ? { ...common, challengeId: scope!.id, scopeDigest: scope!.digest } : null });
  };
  const consumeProof = async (tuple: RoutineFullAccessTuple, proof: string, entry: Entry, scope: Scope, duplicate = false) => {
    if (!proof || proof.length > 4000 || !scopeCurrent(entry, scope)) throw new RoutineCliError("permission_denied");
    let verified: RoutineFullAccessProof;
    try { verified = RoutineFullAccessProofSchema.parse(await options.platform.verify(tuple, proof)); }
    catch (error: unknown) {
      verificationUnavailable = true;
      console.warn("[routine-origin] Browser proof unavailable", error instanceof Error ? error.name : "UnknownError");
      if (entry.scope === scope) invalidate(entry);
      throw new RoutineCliError("unavailable");
    }
    if (!scopeCurrent(entry, scope) || !Object.entries(tuple).every(([key, value]) => verified[key as keyof typeof verified] === value)
      || verified.purpose !== "routine_cli_full_access_origin" || verified.expiresAt <= now() || verified.expiresAt > now() + 60_000
      || nonces.has(verified.nonce) && !duplicate) {
      if (entry.scope === scope) invalidate(entry);
      throw new RoutineCliError("permission_denied");
    }
    sweep(); if (!nonces.has(verified.nonce) && nonces.size >= 512) {
      if (entry.scope === scope) invalidate(entry);
      throw new RoutineCliError("unavailable");
    }
    nonces.set(verified.nonce, verified.expiresAt);
    verificationUnavailable = false;
  };
  const routing = { handle: options.platform.handle, machineId: options.platform.machineId,
    runtimeSlot: options.platform.runtimeSlot, ownerId: configured.ownerId };
  return {
    status: (principal: RequestPrincipal, chatId: string): Promise<RoutineFullAccessStatus> => routineCliBoundary(async () => {
      owner(principal); CanonicalChatIdSchema.parse(chatId); sweep(); const entry = entries.get(chatId);
      try { await inspect(principal, chatId, entry?.scope?.target); }
      catch (error: unknown) {
        if (entry?.scope) invalidate(entry);
        if (!(error instanceof RoutineCliError)) throw error;
        if (["target_required", "target_unavailable", "revision_conflict"].includes(error.code)) return projection(entry, "target_required");
        if (error.code === "permission_denied") return projection(entry, "ineligible");
        throw error;
      }
      return projection(entry);
    }),
    createChallenge: (principal: RequestPrincipal, chatId: string, raw: unknown): Promise<RoutineFullAccessStatus> => routineCliBoundary(async () => {
      owner(principal); CanonicalChatIdSchema.parse(chatId); const input = RoutineFullAccessCreateChallengeSchema.parse(raw); sweep();
      const previous = entries.get(chatId);
      if (input.baseRevision !== (previous?.revision ?? 0)) throw new RoutineCliError("revision_conflict");
      const target = await inspect(principal, chatId);
      if (entries.get(chatId) !== previous || input.baseRevision !== (previous?.revision ?? 0)) throw new RoutineCliError("revision_conflict");
      if (!previous && entries.size >= maxScopes) throw new RoutineCliError("unavailable");
      const entry = previous ?? { chatId, revision: 0, touchedAt: now() }; invalidate(entry);
      const id = `rcfull_${randomBytes(16).toString("hex")}`, expiresAt = now() + MAX_LIFETIME;
      const scope: Scope = { id, revision: entry.revision, expiresAt, target: Object.freeze(structuredClone(target)),
        digest: hash({ purpose: "routine_cli_full_access_scope:v1", ...configured, chatId, id,
          revision: entry.revision, expiresAt, actions, target }) };
      entry.scope = scope; entries.set(chatId, entry); return projection(entry);
    }),
    submitDecision: (principal: RequestPrincipal, chatId: string, challengeId: string,
      raw: unknown, proof: string): Promise<RoutineFullAccessStatus> => routineCliBoundary(async () => {
      owner(principal); CanonicalChatIdSchema.parse(chatId); RoutineFullAccessIdSchema.parse(challengeId); sweep();
      const input = RoutineFullAccessDecisionSubmitSchema.parse(raw), entry = entries.get(chatId), scope = entry?.scope;
      if (!entry || !scope || scope.id !== challengeId || scope.digest !== input.scopeDigest || !scopeCurrent(entry, scope)) throw new RoutineCliError("permission_denied");
      const duplicate = !!scope.decision && isDeepStrictEqual(scope.decision, input);
      if (scope.decision && !duplicate) throw new RoutineCliError("revision_conflict");
      await inspectScope(principal, entry, scope);
      await consumeProof({ kind: "scope_decision", ...routing, chatId, challengeId, ...input }, proof, entry, scope, duplicate);
      await inspectScope(principal, entry, scope);
      if (!scopeCurrent(entry, scope) || scope.decision && !isDeepStrictEqual(scope.decision, input)) throw new RoutineCliError("revision_conflict");
      if (!scope.decision) {
        scope.decision = Object.freeze(input);
        entry.revision = nextRevision(); entry.touchedAt = now();
      } // Fixed scope policyRevision/digest and original expiry are never refreshed, including retries.
      if (input.decision === "decline") invalidate(entry);
      return projection(entry);
    }),
    revoke: (principal: RequestPrincipal, chatId: string, raw: unknown): Promise<RoutineFullAccessStatus> => routineCliBoundary(async () => {
      owner(principal); CanonicalChatIdSchema.parse(chatId); const input = RoutineFullAccessRevokeSchema.parse(raw); sweep();
      const entry = entries.get(chatId);
      if (input.baseRevision !== (entry?.revision ?? 0)) throw new RoutineCliError("revision_conflict");
      if (entry) invalidate(entry); // A principal can remove authority, never create it.
      return projection(entry);
    }),
    beforeTurnDispatch: async (input: RoutineFullAccessTurnAdmission): Promise<void | (() => void)> => {
      sweep(); const entry = entries.get(input.chatId), scope = entry?.scope;
      if (!entry || !scope) return;
      if (input.owner.type !== "personal" || input.owner.ownerId !== configured.ownerId || input.actorId !== configured.ownerId
        || input.run.driverKind !== "claude_code" || input.run.interactionMode !== "default" || input.run.permissionMode !== "full_access"
        || input.body.permissionMode !== "full_access" || input.body.interactionMode !== "default"
        || input.run.context?.agent || input.run.attempt !== 1 || input.run.id !== input.runId
        || input.run.chatId !== input.chatId || input.run.turnId !== input.turnId || input.body.clientRequestId !== input.clientRequestId
        || !isDeepStrictEqual(input.run.selection, input.body.selection)) { invalidate(entry); return; }
      if (input.scopeId !== scope.id || !input.proof || scope.decision?.decision !== "approve" || !scopeCurrent(entry, scope)) return;
      try {
        const principal = owner(input.principal);
        await inspect(principal, input.chatId, scope.target, input);
        const requestDigest = createHash("sha256").update(routineFullAccessTurnRequestIdentity(input.body)).digest("hex");
        await consumeProof({ kind: "turn", ...routing, chatId: input.chatId, scopeId: scope.id,
          clientRequestId: input.clientRequestId, requestDigest }, input.proof, entry, scope);
        await inspect(principal, input.chatId, scope.target, input);
        if (!scopeCurrent(entry, scope) || scope.decision?.decision !== "approve" || leases.has(input.runId)) return;
        if (leases.size >= maxRunLeases) throw new RoutineCliError("unavailable");
        const lease: RunLease = { entry, scope, runId: input.runId, turnId: input.turnId,
          principal: Object.freeze({ ...principal }), controller: new AbortController(), detach() {} };
        leases.set(input.runId, lease); return () => release(lease);
      } catch (error: unknown) {
        // A failed matching admission cannot leave earlier authority live or revive it after drift.
        if (entry.scope === scope) invalidate(entry);
        throw error;
      }
    },
    bindSource(source: RoutineCliSourceContext, signal: AbortSignal): RoutineFullAccessSourceLease | null {
      sweep(); const identity = source.identity;
      const lease = identity.kind === "chat_run" ? leases.get(identity.runId) : undefined;
      if (!lease || !leaseCurrent(lease) || lease.source || signal.aborted || source.harness !== "claude"
        || identity.kind !== "chat_run" || identity.route !== "native" || source.ownerId !== configured.ownerId
        || source.computerId !== configured.computerId || identity.chatId !== lease.entry.chatId) return null;
      lease.source = source; const abort = () => release(lease); signal.addEventListener("abort", abort, { once: true });
      lease.detach = () => signal.removeEventListener("abort", abort);
      const current = () => leaseCurrent(lease) && lease.source === source && !signal.aborted && Date.parse(source.expiresAt) > now();
      return Object.freeze({ target: lease.scope.target, revision: lease.scope.revision, current, release: () => release(lease),
        async validateWithin(trx: Transaction<OwnerBotDatabase>) {
          if (!trx.isTransaction || !current()) return false;
          try {
            await ordinaryWithin(trx, lease.entry.chatId);
            const run = await trx.selectFrom("chat_runs").select(["id", "context_snapshot"]).where("id", "=", lease.runId)
              .where("chat_id", "=", lease.entry.chatId).where("turn_id", "=", lease.turnId)
              .where("driver_kind", "=", "claude_code").where("permission_mode", "=", "full_access")
              .where("interaction_mode", "=", "default").where("attempt", "=", 1)
              .where("status", "in", ["accepted", "running", "waiting_for_approval", "waiting_for_input"]).forShare().executeTakeFirst();
            const context = typeof run?.context_snapshot === "string" ? JSON.parse(run.context_snapshot) : run?.context_snapshot;
            if (!run || context && typeof context === "object" && "agent" in context && context.agent) { invalidate(lease.entry); return false; }
            await options.targets.resolveOwnerDefaultWithin(trx, lease.principal, lease.scope.target);
            return current();
          } catch (error: unknown) {
            if (lease.entry.scope === lease.scope) invalidate(lease.entry);
            if (!(error instanceof RoutineCliError)) console.warn("[routine-origin] Current scope unavailable", error instanceof Error ? error.name : "UnknownError");
            return false;
          }
        } });
    },
    close() { closed = true; clearInterval(timer); for (const lease of leases.values()) release(lease); entries.clear(); nonces.clear(); },
  };
}
export type RoutineFullAccessService = ReturnType<typeof createRoutineFullAccessService>;
