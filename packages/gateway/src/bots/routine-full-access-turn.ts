import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  RoutineFullAccessProofSchema, routineFullAccessTurnRequestIdentity,
  type CanonicalChatRun, type RoutineFullAccessProof, type RoutineFullAccessTuple,
} from "@matrix-os/contracts";
import type { Kysely, Transaction } from "kysely";
import type { ChatDatabase } from "../chat/database.js";
import type { CanonicalProviderRunInput } from "../chat/provider-adapter.js";
import { hasNonPrivateChatScope } from "../chat/private-routine-authority.js";
import type { RoutineFullAccessTurnAdmission } from "../chat/turn-admission.js";
import type { OwnerBotDatabase } from "./database.js";
import type { RoutineCliScope } from "./repositories/routine-cli-preferences.js";
import { RoutineCliError } from "./routine-cli-errors.js";
import { lockRoutineCliPolicyScope } from "./routine-cli-lock-order.js";
import type { RoutineCliSourceContext } from "./routine-cli-source-context.js";
import type { RoutineCliRememberedTarget, RoutineCliTargetService } from "./routine-cli-targets.js";

const PROOF_TTL_MS = 60_000;
const RUN_TTL_MS = 30 * 60_000;
const MAX_PROOFS = 512;
const MAX_RUNS = 256;
const ACTIVE_RUN = ["accepted", "running", "waiting_for_approval", "waiting_for_input"] as const;

type SourceType = {
  harness: RoutineCliSourceContext["harness"];
  route: "native" | "managed";
};
const SOURCE_BY_DRIVER: Partial<Record<CanonicalChatRun["driverKind"], SourceType>> = {
  claude_code: { harness: "claude", route: "native" },
  codex: { harness: "codex", route: "native" },
  hermes: { harness: "hermes", route: "native" },
  opencode: { harness: "opencode", route: "native" },
  pi: { harness: "pi", route: "native" },
  matrix_pi: { harness: "pi", route: "managed" },
};

type Lease = {
  admission: Omit<RoutineFullAccessTurnAdmission, "proof" | "body">;
  sourceType: SourceType;
  target: RoutineCliRememberedTarget;
  expiresAt: number;
  binding?: RoutineCliSourceContext;
  detach?: () => void;
  clientRequestId: string;
};

export interface RoutineFullAccessSourceLease {
  readonly target: RoutineCliRememberedTarget;
  current(): boolean;
  validateWithin(trx: Transaction<OwnerBotDatabase>): Promise<boolean>;
  release(): void;
}

/** A proof can open one fresh run. The lease lives only in this Gateway process. */
export function createRoutineFullAccessTurnService(options: {
  db: Kysely<OwnerBotDatabase>;
  scope: RoutineCliScope;
  targets: Pick<RoutineCliTargetService, "resolveOwnerDefaultWithin">;
  platform: {
    handle: string; machineId: string; runtimeSlot: string;
    verifyFullAccess(tuple: RoutineFullAccessTuple, proof: string): Promise<RoutineFullAccessProof>;
  };
  now?: () => number;
}) {
  const { ownerId, computerId } = options.scope;
  const now = options.now ?? Date.now;
  const leases = new Map<string, Lease>(); // <=MAX_RUNS; expire with live Run, source or shutdown.
  const nonces = new Map<string, number>(); // <=MAX_PROOFS; keep only until signed proof expiry.
  let closed = false, verifying = 0;
  const release = (lease: Lease) => {
    if (leases.get(lease.admission.run.id) !== lease) return;
    leases.delete(lease.admission.run.id);
    lease.detach?.();
  };
  const leaseCurrent = (lease: Lease) => !closed && leases.get(lease.admission.run.id) === lease && lease.expiresAt > now();
  const sweep = () => {
    for (const [nonce, expiresAt] of nonces) if (expiresAt <= now()) nonces.delete(nonce);
    for (const lease of leases.values()) if (!leaseCurrent(lease)) release(lease);
  };
  const timer = setInterval(sweep, PROOF_TTL_MS);
  timer.unref?.();

  const inspectWithin = async (trx: Transaction<OwnerBotDatabase>, admission: Lease["admission"],
    clientRequestId: string, pinned?: RoutineCliRememberedTarget) => {
    const { owner, chatId, run, principal } = admission;
    await lockRoutineCliPolicyScope(trx, options.scope);
    const chat = await trx.selectFrom("chats").select("id").where("id", "=", chatId)
      .where("owner_id", "=", ownerId).where("owner_type", "=", "personal")
      .where("lifecycle", "=", "active").where("collaboration", "is", null).forUpdate().executeTakeFirst();
    if (!chat || await hasNonPrivateChatScope(trx as unknown as Transaction<ChatDatabase>, owner, chatId)
      || await trx.selectFrom("bot_chat_bindings").select("bot_id").where("chat_id", "=", chatId)
        .where("removed_at", "is", null).limit(1).forUpdate().executeTakeFirst()) throw new RoutineCliError("permission_denied");
    const stored = await trx.selectFrom("chat_runs").select(["selection", "context_snapshot"]).where("id", "=", run.id)
      .where("chat_id", "=", chatId).where("turn_id", "=", run.turnId).where("client_request_id", "=", clientRequestId)
      .where("attempt", "=", 1).where("driver_kind", "=", run.driverKind).where("instance_id", "=", run.instanceId)
      .where("permission_mode", "=", "full_access").where("interaction_mode", "=", "default")
      .where("status", "in", pinned ? ACTIVE_RUN : ["accepted"]).forShare().executeTakeFirst();
    const selection = typeof stored?.selection === "string" ? JSON.parse(stored.selection) : stored?.selection;
    const context = typeof stored?.context_snapshot === "string" ? JSON.parse(stored.context_snapshot) : stored?.context_snapshot;
    if (!stored || !isDeepStrictEqual(selection, run.selection) || (context && typeof context === "object" && "agent" in context && context.agent))
      throw new RoutineCliError("permission_denied");
    return options.targets.resolveOwnerDefaultWithin(trx, principal, pinned);
  };
  return {
    async beforeDispatch(input: RoutineFullAccessTurnAdmission): Promise<void | (() => void)> {
      const { principal, owner, chatId, run, body, proof } = input;
      const sourceType = SOURCE_BY_DRIVER[run.driverKind];
      if (closed || !sourceType || !proof || proof.length > 4000 || owner.type !== "personal" || owner.ownerId !== ownerId
        || principal.userId !== ownerId || (principal.source !== "jwt" && principal.source !== "platform-verified")
        || run.chatId !== chatId || run.attempt !== 1 || run.status !== "accepted" || run.context?.agent
        || run.permissionMode !== "full_access" || run.interactionMode !== "default"
        || body.permissionMode !== "full_access" || body.interactionMode !== "default"
        || !isDeepStrictEqual(body.selection, run.selection)) return;
      sweep();
      if (leases.has(run.id) || leases.size + verifying >= MAX_RUNS || nonces.size >= MAX_PROOFS) return;
      verifying++;
      try {
        const tuple: RoutineFullAccessTuple = {
          kind: "direct_turn", handle: options.platform.handle, machineId: options.platform.machineId,
          runtimeSlot: options.platform.runtimeSlot, ownerId, chatId, clientRequestId: body.clientRequestId,
          requestDigest: createHash("sha256").update(routineFullAccessTurnRequestIdentity(body)).digest("hex"),
        };
        const verified = RoutineFullAccessProofSchema.parse(await options.platform.verifyFullAccess(tuple, proof));
        if (closed || verified.kind !== "direct_turn" || !Object.entries(tuple).every(([key, value]) => value === verified[key as keyof typeof verified])
          || verified.expiresAt <= now() || verified.expiresAt > now() + PROOF_TTL_MS || nonces.has(verified.nonce)
          || nonces.size >= MAX_PROOFS || leases.has(run.id)) return;
        // Claim the nonce synchronously before the transactional snapshot. A failed admission never restores a proof.
        nonces.set(verified.nonce, verified.expiresAt);
        const admission = structuredClone({ principal, owner, chatId, run });
        const target = await options.db.transaction().execute(trx => inspectWithin(trx, admission, body.clientRequestId));
        if (closed || verified.expiresAt <= now() || leases.has(run.id)) return;
        const lease = { admission, sourceType, target: Object.freeze(target), expiresAt: now() + RUN_TTL_MS, clientRequestId: body.clientRequestId };
        leases.set(run.id, lease);
        return () => release(lease);
      } finally { verifying--; }
    },
    bindSource(source: RoutineCliSourceContext, input: CanonicalProviderRunInput, signal: AbortSignal): RoutineFullAccessSourceLease | null {
      sweep();
      const identity = source.identity;
      if (identity.kind !== "chat_run" || source.ownerId !== ownerId || source.computerId !== computerId || signal.aborted) return null;
      const lease = leases.get(identity.runId);
      if (!lease || lease.binding || !leaseCurrent(lease)) return null;
      const { chatId, run } = lease.admission;
      if (identity.route !== lease.sourceType.route || source.harness !== lease.sourceType.harness
        || input.owner.type !== "personal" || input.owner.ownerId !== ownerId || input.sharedScopeId
        || identity.chatId !== chatId || input.chatId !== chatId || input.runId !== run.id || input.turnId !== run.turnId
        || input.permissionMode !== "full_access" || input.interactionMode !== "default"
        || !isDeepStrictEqual(input.selection, run.selection)) return null;
      lease.binding = source;
      const abort = () => release(lease);
      signal.addEventListener("abort", abort, { once: true });
      lease.detach = () => signal.removeEventListener("abort", abort);
      const current = () => leaseCurrent(lease) && lease.binding === source && !signal.aborted && Date.parse(source.expiresAt) > now();
      return Object.freeze({ target: lease.target, current, release: abort, async validateWithin(trx: Transaction<OwnerBotDatabase>) {
        if (!trx.isTransaction || !current()) return false;
        try {
          await inspectWithin(trx, lease.admission, lease.clientRequestId, lease.target);
          return current();
        } catch (error: unknown) {
          release(lease);
          if (!(error instanceof RoutineCliError)) console.warn("[routine-full-access] Live source unavailable", error instanceof Error ? error.name : "UnknownError");
          return false;
        }
      } });
    },
    close() {
      closed = true;
      clearInterval(timer);
      for (const lease of leases.values()) release(lease);
      nonces.clear();
    },
  };
}
