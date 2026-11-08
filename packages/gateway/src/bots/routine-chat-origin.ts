import { beginOriginTransaction, boundOriginQueries, hasAcceptedBinding } from "./routine-chat-origin-target.js";
import { routineChatOriginPendingIds } from "./routine-chat-origin-pending.js";
import { createHash } from "node:crypto";
import { type Kysely } from "kysely";
import { CanonicalChatIdSchema, RoutineChatOriginViewSchema, RoutineOriginDecisionSubmitSchema, type RoutineChatOriginView } from "@matrix-os/contracts";
import type { OwnerBotDatabase } from "./database.js";
import type { BotStateTransactions } from "./events.js";
import { BotInteractionError, projectBotInteraction, type BotInteractionService } from "./interactions.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import type { BotExecutor } from "./repositories/shared.js";
import { routineChatOriginForInteraction, type RoutineChatOrigin } from "./routine-chat-origin-map.js";
import type { VerifiedRoutineOriginApproval } from "./routine-origin-platform-client.js";
import { hasNonPrivateChatScope } from "../chat/private-routine-authority.js";
import type { ChatRepository } from "../chat/repository.js";
import { pendingRoutineChatDeliveries, hasPendingRoutineChatOutput } from "./routine-chat-origin-delivery.js";

export interface RoutineChatOriginDependencies {
  db: Kysely<OwnerBotDatabase>; transact: BotStateTransactions;
  chats: Pick<ChatRepository, "appendRoutineReceipt">;
  interactions: Pick<BotInteractionService, "resolveWithin">;
  computerId: string;
  expectedMachine: { machineId: string; handle: string; runtimeSlot: string };
  now?: () => Date; intervalMs?: number;
}
async function privateSource(db: BotExecutor, ownerId: string, chatId: string) {
  const chat = await db.selectFrom("chats").select("id").where("id", "=", chatId).where("owner_type", "=", "personal")
    .where("owner_id", "=", ownerId).where("lifecycle", "=", "active").where("collaboration", "is", null)
    .forNoKeyUpdate().executeTakeFirst();
  return chat && !await hasNonPrivateChatScope(db as never, { type: "personal", ownerId }, chatId);
}
async function liveOrigin(db: BotExecutor, origin: RoutineChatOrigin, lockTarget = true) {
  // Source lock always precedes canonical Chat/binding read locks. No target->source reversal.
  if (!await privateSource(db, origin.ownerId, origin.sourceChatId)) return;
  if (origin.canonicalChatId === origin.sourceChatId || !await hasAcceptedBinding(db, origin.ownerId, origin.canonicalChatId, origin.botId, origin.bindingCreatedAt, lockTarget ? "ordered" : false)) return;
  return db.selectFrom("chat_runs as run").innerJoin("chat_turns as turn", join => join.onRef("turn.id", "=", "run.turn_id").onRef("turn.chat_id", "=", "run.chat_id"))
    .innerJoin("chat_messages as message", join => join.onRef("message.id", "=", "turn.input_message_id").onRef("message.chat_id", "=", "turn.chat_id"))
    .select("message.id").where("run.id", "=", origin.sourceRunId).where("run.chat_id", "=", origin.sourceChatId)
    .where("message.role", "=", "user").where("message.state", "=", "committed").executeTakeFirst();
}
/** Source presentation and delivery only. This service has no scheduled-work admission/dispatch port. */
export function createRoutineChatOriginService(deps: RoutineChatOriginDependencies) {
  const now = () => deps.now?.() ?? new Date();
  const interval = deps.intervalMs ?? 5_000;
  if (!Number.isInteger(interval) || interval < 100 || interval > 60_000 || !deps.computerId
    || !deps.expectedMachine?.machineId || !deps.expectedMachine.handle || !deps.expectedMachine.runtimeSlot
    || typeof deps.chats?.appendRoutineReceipt !== "function" || typeof deps.interactions?.resolveWithin !== "function" || typeof deps.transact !== "function") throw new BotInteractionError("unavailable");
  const active = new Set<Promise<unknown>>(); // Cap64; settled operations evict, close drains.
  function track<T>(work: () => Promise<T>): Promise<T> {
    if (closed || active.size >= 64) return Promise.reject(new BotInteractionError("unavailable"));
    const operation = work(); active.add(operation);
    void operation.then(() => active.delete(operation), () => active.delete(operation));
    return operation;
  }
  let timer: ReturnType<typeof setInterval> | undefined, pending: Promise<void> | undefined, closed = false;
  let recoveryCursor: { updatedAt: string; fireId: string; kind: string } | undefined;
  async function reconcile(ownerId?: string, sourceChatId?: string) {
    if (closed) return;
    // Persisted unprojected set survives missed wakes and restart; DB filters readiness BEFORE LIMIT.
    const candidates = await deps.db.transaction().execute(async db => {
      await boundOriginQueries(db);
      return pendingRoutineChatDeliveries(db, deps.computerId, ownerId, sourceChatId, ownerId ? undefined : recoveryCursor);
    });
    if (!ownerId) recoveryCursor = candidates.length === 32 ? candidates[candidates.length - 1] : undefined;
    let failed = false;
    for (const item of candidates) {
      if (closed) break;
      try { await deps.chats.appendRoutineReceipt(item.ownerId, { ...item, computerId: deps.computerId, now: now().toISOString() }); }
      catch (error: unknown) {
        failed = true;
        console.warn("[routine-origin] Projection unavailable", error instanceof BotInteractionError ? error.code : "unavailable");
      }
    }
    if (failed) throw new BotInteractionError("unavailable");
  }
  function wake() {
    if (closed || pending) return pending ?? Promise.resolve();
    pending = track(() => reconcile()).finally(() => { pending = undefined; });
    return pending;
  }
  return {
    read(ownerId: string, sourceChatId: string): Promise<RoutineChatOriginView> { return track(async () => {
      if (!CanonicalChatIdSchema.safeParse(sourceChatId).success) throw new BotInteractionError("invalid_request");
      await reconcile(ownerId, sourceChatId);
      return deps.transact(ownerId, async tx => {
        await beginOriginTransaction(tx.db, ownerId);
        if (closed || !await privateSource(tx.db, ownerId, sourceChatId)) throw new BotInteractionError("not_found");
        const repository = createBotInteractionsRepository(tx.db), pendingItems = [];
        const candidates = await routineChatOriginPendingIds(tx.db, ownerId, deps.computerId, sourceChatId, now().toISOString());
        for (const candidate of candidates) {
          const interaction = await repository.get({ ownerId, interactionId: candidate.interaction_id }, tx.db);
          if (!interaction) continue;
          const origin = await routineChatOriginForInteraction(tx.db, interaction);
          if (!origin || origin.computerId !== deps.computerId || origin.sourceChatId !== sourceChatId) continue;
          const anchor = await liveOrigin(tx.db, origin);
          if (anchor) pendingItems.push({ sourceChatId, anchorMessageId: anchor.id, interaction: projectBotInteraction(interaction, ownerId) });
        }
        const deliveries = await tx.db.selectFrom("routine_chat_deliveries").select(["message_id", "receipt"])
          .where("owner_id", "=", ownerId).where("source_chat_id", "=", sourceChatId).orderBy("created_at", "desc").orderBy("message_id", "desc").limit(33).execute();
        return RoutineChatOriginViewSchema.parse({ sourceChatId, pending: pendingItems, deliveryPending: await hasPendingRoutineChatOutput(tx.db, ownerId, deps.computerId, sourceChatId),
          deliveries: deliveries.slice(0, 32).map(row => ({ messageId: row.message_id, receipt: row.receipt })), hasMore: deliveries.length > 32 });
      });
    }); },
    resolve(ownerId: string, sourceChatId: string, interactionId: string, raw: unknown, verifiedDecision: VerifiedRoutineOriginApproval) { return track(async () => {
      const request = RoutineOriginDecisionSubmitSchema.safeParse(raw);
      if (!request.success || !CanonicalChatIdSchema.safeParse(sourceChatId).success) throw new BotInteractionError("invalid_request");
      const proof = verifiedDecision, input = request.data;
      const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      if (!proof || proof.purpose !== "routine_origin_approval" || proof.ownerId !== ownerId || proof.sourceChatId !== sourceChatId
        || proof.interactionId !== interactionId || proof.method !== "POST" || proof.path !== `/api/chats/${sourceChatId}/routine-origin/${interactionId}/resolve`
        || proof.kind !== input.kind || proof.baseRevision !== input.baseRevision || proof.decision !== input.decision || proof.bodyDigest !== digest
        || proof.handle !== deps.expectedMachine.handle || proof.machineId !== deps.expectedMachine.machineId || proof.runtimeSlot !== deps.expectedMachine.runtimeSlot) throw new BotInteractionError("not_found");
      return deps.transact(ownerId, async tx => {
        await beginOriginTransaction(tx.db, ownerId);
        if (proof.issuedAt > now().getTime() || proof.expiresAt <= now().getTime() || proof.expiresAt > proof.issuedAt + 60_000) throw new BotInteractionError("expired");
        const interaction = await createBotInteractionsRepository(tx.db).get({ ownerId, interactionId }, tx.db);
        if (!interaction || interaction.responderActorId !== ownerId) throw new BotInteractionError("not_found");
        const origin = await routineChatOriginForInteraction(tx.db, interaction);
        if (!origin || origin.computerId !== deps.computerId || origin.sourceChatId !== sourceChatId || !await liveOrigin(tx.db, origin, false)) throw new BotInteractionError("not_found");
        if (closed) throw new BotInteractionError("unavailable");
        if (proof.expiresAt <= now().getTime()) throw new BotInteractionError("expired");
        // The canonical decision owns the target lock order, including Routine before
        // the binding and Chat for edits. Do not take the target lock early in the alias.
        // Revalidate after the same uncommitted decision. It may already hold the Chat,
        // so this membership recheck must never wait on another binding.
        const decision = await deps.interactions.resolveWithin(tx, ownerId, origin.canonicalChatId, interactionId, input);
        if (!await hasAcceptedBinding(tx.db, ownerId, origin.canonicalChatId, origin.botId, origin.bindingCreatedAt, "recheck")) throw new BotInteractionError("not_found");
        if (closed) throw new BotInteractionError("unavailable");
        if (proof.expiresAt <= now().getTime()) throw new BotInteractionError("expired");
        return decision;
      });
    }); },
    reconcile: (ownerId: string, sourceChatId: string) => track(() => reconcile(ownerId, sourceChatId)),
    wake,
    start() {
      if (timer || closed) return;
      const recover = () => { void wake().catch(error => console.warn("[routine-origin] Recovery unavailable", error instanceof Error ? error.name : "UnknownError")); };
      timer = setInterval(recover, interval); timer.unref(); recover();
    },
    async close() { closed = true; if (timer) clearInterval(timer); await Promise.allSettled([...active]); },
  };
}
export type RoutineChatOriginService = ReturnType<typeof createRoutineChatOriginService>;
