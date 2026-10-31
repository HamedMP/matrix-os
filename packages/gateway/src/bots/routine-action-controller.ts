import { CanonicalProviderRunEventSchema } from "../chat/provider-adapter.js";
import { randomBytes } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod/v4";
import { RoutineCliOperationSchema, RoutineCliRememberTargetSchema, RoutineActionIdSchema, RoutineActionSubmitSchema, RoutineActionViewSchema, ROUTINE_ACTION_NOTICE,
  type RoutineCliAction, type RoutineCliOperation, type RoutineActionProof, type RoutineActionTuple,
  type RoutineActionSubmit, type RoutineActionView } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { RequestPrincipal } from "../request-principal.js";
import { RoutineCliSourceContextSchema, type RoutineCliSourceContext } from "./routine-cli-source-context.js";
import { createRoutineCliSourceService, type RoutineCliVerifiedInvocation, type RoutineCliSourceReference } from "./routine-cli-source.js";
import { createRoutineCliTargetService, type RoutineCliResolvedTarget, type RoutineCliTargetDependencies } from "./routine-cli-targets.js";
import { createRoutineCliRequestsRepository } from "./repositories/routine-cli-requests.js";
import { RoutineCliScopeSchema, type RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import { lockRoutineCliPolicyScope } from "./routine-cli-lock-order.js";
import { freezeIntent, type RoutineCliRequestDependencies } from "./routine-cli-requests.js";
import { routineActionHash, routineActionPolicy, type RoutineActionSourceRegistry, type RoutineSourceHandle, type RoutineSourceProducer } from "./routine-action-source-registry.js";

type Call = { operation: RoutineCliOperation; invocationId: string; signal: AbortSignal };
type TargetCeiling = Readonly<{ botId: string; chatId: string }>;
const withinCeiling = (target: { botId: string; chatId: string }, ceiling?: TargetCeiling) => !ceiling || target.botId === ceiling.botId && target.chatId === ceiling.chatId;
type Entry = { handle: RoutineSourceHandle; reference: RoutineCliSourceReference; invocationId: string; operation: RoutineCliOperation;
  operationDigest: string; target: RoutineCliResolvedTarget; boundTarget?: TargetCeiling; originalReceipt: boolean; fingerprint: string; mode: "allow" | "ask";
  expiresAt: number; challengeId: string; actionDigest: string; status: RoutineActionView["status"]; issued: boolean;
  decision?: RoutineActionSubmit; settle(value: boolean): void; waiting: Promise<boolean>; detach(): void };
const actionFor = (operation: RoutineCliOperation): RoutineCliAction => operation.operation === "propose" ? "propose"
  : ["list", "show", "request"].includes(operation.operation) ? "read" : "control";
/** The host captures one normalized intent/invocation/source/target/policy. No UI/network wait owns a DB transaction.
 * Decisions survive normal invocation exit only when the capability was durably consumed; original source/TTL still fence task claim. */
export function createRoutineCliActionController(options: {
  db: Kysely<OwnerBotDatabase>; scope: RoutineCliScope; agents: Pick<ChatAgentStore, "get">; registry: RoutineActionSourceRegistry;
  platform: { handle: string; machineId: string; runtimeSlot: string; verify(tuple: RoutineActionTuple, proof: string, signal?: AbortSignal): Promise<RoutineActionProof> };
  canAccessTarget: NonNullable<RoutineCliTargetDependencies["canAccessTarget"]>; now?: () => number; ttlMs?: number;
}) {
  const scope = RoutineCliScopeSchema.parse(options.scope), now = options.now ?? Date.now, ttl = options.ttlMs ?? 120_000;
  if (!options.db?.transaction || !options.registry?.validateWithin || !options.platform?.verify || !options.canAccessTarget
    || !options.agents?.get || !Number.isInteger(ttl) || ttl < 1 || ttl > 120_000) throw new Error("Routine action dependencies unavailable");
  const entries = new Map<string, Entry>(); // <=128 total, <=16/source; TTL/source-close/shutdown eviction.
  let closed = false;
  const ledger = createRoutineCliRequestsRepository(options.db);
  const requireOwnerId = (ownerId: string) => { if (ownerId !== scope.ownerId) throw new RoutineCliError("permission_denied"); };
  const live = (entry: Entry) => {
    const registered = options.registry.read(entry.handle.source);
    return !closed && entries.get(entry.invocationId) === entry && entry.expiresAt > now() && !entry.handle.signal.aborted
      && registered?.handle === entry.handle && registered.fingerprint === entry.fingerprint
      && routineActionPolicy(entry.handle.source, registered.policy, actionFor(entry.operation)) === entry.mode;
  };
  const emit = (entry: Entry, resolved = false) => {
    const registered = options.registry.read(entry.handle.source);
    if (entry.handle.source.identity.kind === "terminal_launch") return;
    if (!registered?.producer.publish) throw new RoutineCliError("unavailable");
    registered.producer.publish(CanonicalProviderRunEventSchema.parse(resolved
      ? { type: "approval.resolved", approvalId: entry.challengeId, decision: entry.decision?.decision ?? "cancel" }
      : { type: "approval.requested", approvalId: entry.challengeId, actionDigest: entry.actionDigest,
        title: `Allow routine ${entry.operation.operation}?`, safeDescription: ROUTINE_ACTION_NOTICE,
        risk: "medium", allowedDecisions: ["approve", "decline", "cancel"] }));
  };
  const remove = (entry: Entry, status: RoutineActionView["status"] = "unavailable") => {
    if (entries.get(entry.invocationId) !== entry) return;
    entries.delete(entry.invocationId); entry.status = status; entry.detach(); entry.settle(false);
    if (entry.mode === "ask") { try { emit(entry, true); } catch (error: unknown) { console.warn("[routine-action] Resolution unavailable", error instanceof Error ? error.name : "UnknownError"); } }
  };
  const sweep = () => { for (const entry of entries.values()) if (!live(entry)) remove(entry, entry.expiresAt <= now() ? "expired" : "unavailable"); };
  const timer = setInterval(sweep, 1000); timer.unref?.();
  const match = (source: RoutineCliSourceContext, operation: RoutineCliOperation, invocation: RoutineCliVerifiedInvocation) => {
    const entry = entries.get(invocation.invocationId);
    return entry && live(entry) && entry.reference.sourceId === invocation.sourceId
      && routineActionHash(RoutineCliSourceContextSchema.parse(source)) === routineActionHash(entry.handle.source)
      && entry.operationDigest === invocation.operationDigest && entry.operationDigest === routineActionHash(RoutineCliOperationSchema.parse(operation)) ? entry : null;
  };
  const authorized = (entry: Entry) => entry.mode === "allow" || entry.status === "approved";
  const targetWithin = async (entry: Entry, trx: Transaction<OwnerBotDatabase>) => {
    const target = entry.originalReceipt ? await targets.validatePinnedWithin(trx, entry.handle.source, actionFor(entry.operation), entry.target)
      : await targets.resolveWithin(trx, entry.handle.source, actionFor(entry.operation), entry.target);
    if (!withinCeiling(target, entry.boundTarget)) throw new RoutineCliError("permission_denied");
    return target;
  };
  const sources = createRoutineCliSourceService({ db: options.db, scope, now: () => new Date(now()),
    validateLifecycle: async (source, trx, action, invocation) => {
      await lockRoutineCliPolicyScope(trx, scope);
      return options.registry.validateWithin(source, trx, action, invocation);
    },
    authorizeOperation: async (source, operation, _trx, invocation) => { const entry = match(source, operation, invocation); return !!entry && authorized(entry); },
    authorizeIssueTarget: async (source, operation, trx, invocation) => {
      const entry = match(source, operation, invocation); if (!entry || !authorized(entry)) return false;
      await targetWithin(entry, trx); return live(entry) && authorized(entry);
    },
  });
  const targets = createRoutineCliTargetService({ db: options.db, scope, agents: options.agents, now: () => new Date(now()),
    revalidateSource: sources.revalidateSource, canAccessTarget: options.canAccessTarget });
  const targetKey = (target: RoutineCliResolvedTarget) => routineActionHash([target.ownerId, target.computerId, target.botId, target.chatId, target.bindingCreatedAt, target.preferenceRevision]);
  const authorizeTarget: NonNullable<RoutineCliRequestDependencies["authorizeTarget"]> = async (input) => {
    const entry = match(input.source, input.operation, input.invocation);
    return !!entry && authorized(entry) && withinCeiling(input.target, entry.boundTarget) && targetKey(input.target) === targetKey(entry.target);
  };
  const fresh = async (entry: Entry) => {
    if (!live(entry)) throw new RoutineCliError("permission_denied");
    await options.db.transaction().execute(trx => targetWithin(entry, trx));
    if (!live(entry)) throw new RoutineCliError("permission_denied");
  };
  const project = (entry: Entry): RoutineActionView => RoutineActionViewSchema.parse({ challengeId: entry.challengeId, actionDigest: entry.actionDigest,
    intent: entry.operation, target: { botId: entry.target.botId, chatId: entry.target.chatId },
    sourceLabel: entry.handle.source.identity.kind === "terminal_launch" ? `Terminal ${entry.handle.source.identity.sessionId}`
      : entry.handle.source.identity.kind === "chat_run" ? `Chat ${entry.handle.source.identity.chatId}` : `Bot task ${entry.handle.source.identity.taskId}`,
    sourceKind: entry.handle.source.identity.kind, operation: entry.operation.operation, expiresAt: new Date(entry.expiresAt).toISOString(),
    status: live(entry) ? entry.status : entry.expiresAt <= now() ? "expired" : "unavailable", title: `Allow routine ${entry.operation.operation}?`, description: ROUTINE_ACTION_NOTICE });
  const getEntry = (ownerId: string, id: string) => {
    requireOwnerId(ownerId); RoutineActionIdSchema.parse(id);
    const entry = [...entries.values()].find(value => value.challengeId === id);
    if (!entry || entry.mode !== "ask") throw new RoutineCliError("not_found"); return entry;
  };
  const prepare = async (handle: RoutineSourceHandle, reference: RoutineCliSourceReference, call: Call, boundTarget?: TargetCeiling) => {
    const operation = freezeIntent(RoutineCliOperationSchema.parse(call.operation)), invocationId = z.uuid().parse(call.invocationId).toLowerCase();
    sweep(); if (closed || !options.registry.has(handle) || call.signal.aborted || entries.has(invocationId)) throw new RoutineCliError("permission_denied");
    if (entries.size >= 128 || [...entries.values()].filter(entry => entry.handle === handle).length >= 16) throw new RoutineCliError("unavailable");
    const registered = options.registry.read(handle.source)!;
    const mode = routineActionPolicy(handle.source, registered.policy, actionFor(operation));
    if (mode === "deny") throw new RoutineCliError("permission_denied");
    const prepared = await options.db.transaction().execute(async trx => {
      const receipt = "requestId" in operation ? await ledger.get(scope, operation.requestId, trx) : undefined;
      if (receipt && operation.operation !== "request" && receipt.operationDigest !== routineActionHash(operation)) throw new RoutineCliError("request_conflict");
      const target = receipt ? await targets.validatePinnedWithin(trx, handle.source, actionFor(operation), receipt.target)
        : await targets.resolveWithin(trx, handle.source, actionFor(operation));
      if (!withinCeiling(target, boundTarget)) throw new RoutineCliError("permission_denied");
      return { target: freezeIntent(target), originalReceipt: !!receipt };
    });
    if (call.signal.aborted || !options.registry.has(handle) || options.registry.read(handle.source)?.fingerprint !== registered.fingerprint
      || entries.has(invocationId) || entries.size >= 128 || [...entries.values()].filter(entry => entry.handle === handle).length >= 16) throw new RoutineCliError("permission_denied");
    let settle!: (value: boolean) => void; const waiting = new Promise<boolean>(resolve => { settle = resolve; });
    const expiresAt = Math.min(now() + ttl, Date.parse(handle.source.expiresAt));
    const challengeId = `rcact_${randomBytes(16).toString("hex")}`;
    const entry: Entry = { handle, reference, invocationId, operation, boundTarget, operationDigest: routineActionHash(operation), ...prepared,
      fingerprint: registered.fingerprint, mode, expiresAt, challengeId, actionDigest: routineActionHash({ purpose: "routine_cli_owner_action:v1",
        source: handle.source, sourceId: reference.sourceId, invocationId, operation, boundTarget, target: prepared.target, policy: registered.fingerprint, expiresAt, challengeId }),
      status: mode === "ask" ? "pending" : "approved", issued: false, waiting, settle, detach: () => {} };
    const abort = () => remove(entry);
    call.signal.addEventListener("abort", abort, { once: true }); handle.signal.addEventListener("abort", abort, { once: true });
    entry.detach = () => { call.signal.removeEventListener("abort", abort); handle.signal.removeEventListener("abort", abort); };
    entries.set(invocationId, entry);
    try { if (mode === "ask") emit(entry); else settle(true); }
    catch (error: unknown) { remove(entry); throw error; }
    const allowed = await waiting;
    // Tool callback completion abort is invocation-local; issue/cancel own cleanup after this wait.
    call.signal.removeEventListener("abort", abort);
    if (!allowed) return false;
    await fresh(entry); return true;
  };
  const submitForOwner = async (ownerId: string, id: string, raw: RoutineActionSubmit, proof: string) => {
      const entry = getEntry(ownerId, id), input = RoutineActionSubmitSchema.parse(raw);
      if (!proof || input.actionDigest !== entry.actionDigest) throw new RoutineCliError("permission_denied");
      await fresh(entry);
      const tuple = { ...input, challengeId: entry.challengeId, ownerId: scope.ownerId, handle: options.platform.handle,
        runtimeSlot: options.platform.runtimeSlot, machineId: options.platform.machineId };
      let verified: RoutineActionProof;
      try { verified = await options.platform.verify(tuple, proof, entry.handle.signal); } // no DB/source transaction held
      catch (error: unknown) {
        console.warn("[routine-action] Owner proof unavailable", error instanceof Error ? error.name : "UnknownError");
        throw new RoutineCliError(live(entry) ? "unavailable" : "permission_denied");
      }
      if (!Object.entries(tuple).every(([key, value]) => verified[key as keyof typeof verified] === value) || verified.purpose !== "routine_cli_owner_action"
        || verified.expiresAt <= now() || verified.expiresAt > now() + 60_000) throw new RoutineCliError("permission_denied");
      await fresh(entry);
      if (entry.decision) {
        if (JSON.stringify(entry.decision) !== JSON.stringify(input)) throw new RoutineCliError("revision_conflict");
        return { submission: "already_submitted" as const };
      }
      if (entry.status !== "pending") throw new RoutineCliError("permission_denied");
      entry.decision = freezeIntent(input); entry.expiresAt = Math.min(entry.expiresAt, verified.expiresAt);
      entry.status = input.decision === "approve" ? "approved" : input.decision === "decline" ? "declined" : "cancelled";
      try { emit(entry, true); } catch (error: unknown) { remove(entry); throw error; }
      entry.settle(input.decision === "approve"); return { submission: "accepted" as const };
    };
  return {
    sources, targets, authorizeTarget,
    async register(producer: RoutineSourceProducer, targetCeiling?: { botId: string; chatId: string }) {
      const boundTarget = targetCeiling ? freezeIntent(RoutineCliRememberTargetSchema.pick({ botId: true, chatId: true }).parse(targetCeiling)) : undefined;
      if (producer.source.identity.kind === "bot_child" && !boundTarget) throw new RoutineCliError("permission_denied");
      if (producer.source.ownerId !== scope.ownerId || producer.source.computerId !== scope.computerId) throw new RoutineCliError("permission_denied");
      const handle = options.registry.register(producer);
      let reference: RoutineCliSourceReference;
      try { reference = await sources.register(handle.source); }
      catch (error: unknown) { options.registry.revoke(handle); throw error; }
      return { source: handle.source, reference,
        authorize: (call: Call) => prepare(handle, reference, call, boundTarget),
        async issue(call: Call) {
          const operation = RoutineCliOperationSchema.parse(call.operation), entry = match(handle.source, operation,
            { sourceId: reference.sourceId, invocationId: z.uuid().parse(call.invocationId).toLowerCase(), operationDigest: routineActionHash(operation) });
          if (!entry || call.signal.aborted || entry.issued || !authorized(entry)) throw new RoutineCliError("permission_denied");
          entry.issued = true;
          const delivery = await sources.issue(reference, { invocationId: entry.invocationId, operation });
          if (call.signal.aborted || !live(entry)) { await sources.releaseInvocation(reference, entry.invocationId); throw new RoutineCliError("permission_denied"); }
          return delivery;
        },
        async cancel(input: { invocationId: string; reason: string; operation?: RoutineCliOperation }) {
          const entry = entries.get(z.uuid().parse(input.invocationId).toLowerCase());
          if (!entry || entry.handle !== handle) return;
          const released = await sources.releaseInvocation(reference, entry.invocationId);
          if (!released.consumed) remove(entry);
          // A queued consumed intent retains its still-live exact unexpired approval for the later real task claim.
        },
        async revoke() { options.registry.revoke(handle); await sources.revoke(reference); },
      };
    },
    get(principal: RequestPrincipal, id: string) { return project(getEntry(principal.userId, id)); },
    list(principal: RequestPrincipal, includeChat = false) {
      requireOwnerId(principal.userId); sweep(); return [...entries.values()].filter(entry => entry.mode === "ask" && (includeChat || entry.handle.source.identity.kind === "terminal_launch")).map(project);
    },
    submit: (principal: RequestPrincipal, id: string, input: RoutineActionSubmit, proof: string) => submitForOwner(principal.userId, id, input, proof),
    async submitChat(ownerId: string, chatId: string, runId: string, id: string, input: RoutineActionSubmit, proof: string) {
      const entry = getEntry(ownerId, id), identity = entry.handle.source.identity;
      if (!(identity.kind === "chat_run" && identity.chatId === chatId && identity.runId === runId
        || identity.kind === "bot_child" && entry.target.chatId === chatId && identity.runId === runId)) throw new RoutineCliError("permission_denied");
      return submitForOwner(ownerId, id, input, proof);
    },
    close() { closed = true; clearInterval(timer); for (const entry of [...entries.values()]) remove(entry); },
  };
}
export type RoutineCliActionController = ReturnType<typeof createRoutineCliActionController>;
