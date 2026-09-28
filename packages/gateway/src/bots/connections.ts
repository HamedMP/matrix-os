/**
 * Starting and completing a bot's connection request (spec 536,
 * technical-design "Conversational Setup and Collaboration"). When the owner
 * starts one:
 *
 * - one account of the service is already connected: it is granted;
 * - several are: the owner is asked which to use;
 * - none is: the owner gets the provider-hosted consent URL, and the request
 *   records the connections that existed at that moment.
 *
 * A browser return never proves success. Reconciliation syncs and reads the
 * account inventory, and exactly one new connection completes the request;
 * several ask which one; none by expiry expires it. Each outcome grants,
 * resolves, and announces in one transaction, and returns the continuation
 * for the caller to admit. No transaction spans a network call.
 */
import { BotInteractionIdSchema, ResolveBotInteractionResponseSchema, type BotEffect, type ResolveBotInteractionResponse } from "@matrix-os/contracts";
import { sql } from "kysely";
import type { BotStateTransaction, BotStateTransactions } from "./events.js";
import { BotIntegrationError, type BotIntegrationClient, type BotIntegrationConnection } from "./integration-client.js";
import type { BotIntegrationTools } from "./integration-tools.js";
import { BotInteractionError, type BotContinuation } from "./interactions.js";
import { connectOutcome, createBotConnectRequestsRepository } from "./repositories/connect-requests.js";
import { createBotGrantsRepository } from "./repositories/grants.js";
import { createBotInteractionsRepository, type BotInteractionRecord } from "./repositories/interactions.js";
import { BotStateError } from "./repositories/shared.js";

const AUDIENCE = "direct";
const CONNECT_LIFETIME_MS = 15 * 60_000;
const CHOICE_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_ACCOUNT_OPTIONS = 10;
const MAX_OWNERS_PER_PASS = 16;
const MAX_CONTINUATIONS_PER_OWNER = 100;
const CONTINUATION_RETRY_MS = 60_000;
/** The reconcile read publishes nothing, so no owner scope applies to it. */
const PASS_OWNER = "bot-connection-reconcile";

type ConnectPayload = { kind: "connect_request"; service: string; access: BotEffect[]; connectRequestId: string };
type StartResult = { response: ResolveBotInteractionResponse; continuation?: BotContinuation };

function continuationFor(interaction: BotInteractionRecord, text: string): BotContinuation {
  return { chatId: interaction.chatId, clientRequestId: `req_answer_${interaction.interactionId}`, text };
}

function responseFor(interaction: Pick<BotInteractionRecord, "interactionId" | "status" | "revision">, connectUrl?: string): ResolveBotInteractionResponse {
  return ResolveBotInteractionResponseSchema.parse({
    interaction: { interactionId: interaction.interactionId, status: interaction.status, revision: interaction.revision },
    ...(connectUrl ? { connectUrl } : {}),
  });
}

export function createBotConnections(deps: {
  client: BotIntegrationClient;
  transact: BotStateTransactions;
  tools: Pick<BotIntegrationTools, "declaredEffects">;
  now?: () => Date;
}) {
  const now = () => deps.now?.() ?? new Date();

  async function publishResolved(tx: BotStateTransaction, interaction: BotInteractionRecord): Promise<void> {
    await tx.publish(interaction.chatId, "interaction.resolved", {
      interactionId: interaction.interactionId, chatId: interaction.chatId, status: interaction.status, revision: interaction.revision,
    });
  }

  /** Grants `connection`, resolves the request, and announces both. */
  async function grantAndResolve(tx: BotStateTransaction, interaction: BotInteractionRecord, connection: BotIntegrationConnection, at: string): Promise<{ resolved: BotInteractionRecord; text: string }> {
    const payload = interaction.payload as ConnectPayload;
    const effects = await deps.tools.declaredEffects(interaction.ownerId, interaction.botId, payload.service);
    if (effects.length === 0) throw new BotInteractionError("invalid_request");
    let revision: number;
    try {
      ({ grant: { revision } } = await createBotGrantsRepository(tx.db).grant({
        ownerId: interaction.ownerId, botId: interaction.botId, service: payload.service, connectionId: connection.connectionId,
        accountLabel: connection.label, effects, audience: AUDIENCE, grantedByActorId: interaction.ownerId, now: at,
      }, tx.db));
    } catch (error: unknown) {
      if (error instanceof BotStateError && error.code === "conflict") throw new BotInteractionError("conflict");
      throw error;
    }
    const text = `Connected ${payload.service} account "${connection.label}" (connection ${connection.connectionId}). Continue the task.`;
    const resolved = await createBotInteractionsRepository(tx.db).resolve({
      ownerId: interaction.ownerId, interactionId: interaction.interactionId, baseRevision: interaction.revision,
      responderActorId: interaction.responderActorId, resolution: { action: "start", connectionId: connection.connectionId, continuation: text }, now: at,
    }, tx.db);
    await publishResolved(tx, resolved);
    await tx.publish(resolved.chatId, "bot.authority.changed", { agentId: resolved.botId, revision });
    return { resolved, text };
  }

  /** Resolves the request and asks which of several accounts to use; the choice continues the task. */
  async function askWhich(tx: BotStateTransaction, interaction: BotInteractionRecord, options: readonly BotIntegrationConnection[], at: string): Promise<BotInteractionRecord> {
    const payload = interaction.payload as ConnectPayload;
    const interactions = createBotInteractionsRepository(tx.db);
    const resolved = await interactions.resolve({
      ownerId: interaction.ownerId, interactionId: interaction.interactionId, baseRevision: interaction.revision,
      responderActorId: interaction.responderActorId, resolution: { action: "start", choose: true }, now: at,
    }, tx.db);
    await publishResolved(tx, resolved);
    const { interaction: choice } = await interactions.create({
      ownerId: interaction.ownerId, botId: interaction.botId, chatId: interaction.chatId, taskId: interaction.taskId, kind: "account_choice",
      payload: { kind: "account_choice", service: payload.service, options: options.slice(0, MAX_ACCOUNT_OPTIONS).map((option) => ({ connectionId: option.connectionId, label: option.label })) },
      responderActorId: interaction.responderActorId, blocking: true,
      expiresAt: new Date(Date.parse(at) + CHOICE_LIFETIME_MS).toISOString(), now: at,
    }, tx.db);
    await tx.publish(choice.chatId, "interaction.requested", {
      interactionId: choice.interactionId, chatId: choice.chatId, agentId: choice.botId, kind: choice.kind,
      blocking: true, expiresAt: choice.expiresAt, revision: choice.revision,
    });
    return resolved;
  }

  /** The pending, unexpired connection request at `baseRevision` that this responder may start. */
  async function loadPending(tx: BotStateTransaction, responderId: string, chatId: string, interactionId: string, baseRevision: number): Promise<BotInteractionRecord> {
    const interaction = await createBotInteractionsRepository(tx.db).get({ ownerId: responderId, interactionId }, tx.db);
    if (!interaction || interaction.chatId !== chatId || interaction.responderActorId !== responderId) throw new BotInteractionError("not_found");
    if (interaction.kind !== "connect_request") throw new BotInteractionError("invalid_request");
    if (interaction.status === "expired" || (interaction.status === "pending" && Date.parse(interaction.expiresAt) <= now().getTime())) {
      throw new BotInteractionError("expired");
    }
    if (interaction.status !== "pending" || interaction.revision !== baseRevision) throw new BotInteractionError("conflict");
    return interaction;
  }

  async function inventory(ownerId: string): Promise<BotIntegrationConnection[]> {
    try {
      return await deps.client.inventory(ownerId);
    } catch (error: unknown) {
      if (error instanceof BotIntegrationError) throw new BotInteractionError("unavailable");
      throw error;
    }
  }

  return {
    /** The owner starts a connection request. */
    async startConnect(responderId: string, chatId: string, interactionId: string, baseRevision: number): Promise<StartResult> {
      const interaction = await deps.transact(responderId, (tx) => loadPending(tx, responderId, chatId, interactionId, baseRevision));
      const payload = interaction.payload as ConnectPayload;
      const accounts = (await inventory(responderId)).filter((connection) => connection.service === payload.service);
      const at = now().toISOString();
      if (accounts.length > 0) {
        return deps.transact(responderId, async (tx) => {
          // Checked again inside the transaction that acts on it.
          const current = await loadPending(tx, responderId, chatId, interactionId, baseRevision);
          if (accounts.length === 1) {
            const { resolved, text } = await grantAndResolve(tx, current, accounts[0]!, at);
            return { response: responseFor(resolved), ...(resolved.blocking ? { continuation: continuationFor(resolved, text) } : {}) };
          }
          return { response: responseFor(await askWhich(tx, current, accounts, at)) };
        });
      }
      let url: string;
      try {
        url = await deps.client.connect(responderId, payload.service);
      } catch (error: unknown) {
        if (error instanceof BotIntegrationError) throw new BotInteractionError("unavailable");
        throw error;
      }
      await deps.transact(responderId, async (tx) => {
        // The owner may have declined or another request may have resolved while
        // the provider prepared consent. Lock before persisting this URL's request.
        await tx.db.selectFrom("bot_interactions").select("interaction_id")
          .where("owner_id", "=", responderId).where("interaction_id", "=", interactionId)
          .forUpdate().executeTakeFirst();
        await loadPending(tx, responderId, chatId, interactionId, baseRevision);
        const requests = createBotConnectRequestsRepository(tx.db);
        // Starting again reuses the request, and so its baseline.
        if (await requests.forInteraction({ ownerId: responderId, interactionId }, tx.db)) return;
        await requests.create({
          ownerId: responderId, interactionId, requestId: payload.connectRequestId, service: payload.service, baselineConnectionIds: [],
          expiresAt: new Date(Math.min(Date.parse(interaction.expiresAt), Date.parse(at) + CONNECT_LIFETIME_MS)).toISOString(), now: at,
        }, tx.db);
      });
      return { response: responseFor(interaction, url) };
    },

    /**
     * Completes an owner's started connection requests from the live
     * inventory. Returns the continuations to admit.
     */
    async reconcile(ownerId: string): Promise<BotContinuation[]> {
      const pending = await deps.transact(ownerId, (tx) => createBotConnectRequestsRepository(tx.db).listPending({ ownerId }, tx.db));
      if (pending.length === 0) return [];
      try {
        await deps.client.sync(ownerId);
      } catch (error: unknown) {
        // A failed sync still leaves the current inventory to compare against.
        if (!(error instanceof BotIntegrationError)) throw error;
      }
      const connected = await deps.client.inventory(ownerId);
      const continuations: BotContinuation[] = [];
      for (const request of pending) {
        const accounts = connected.filter((connection) => connection.service === request.service);
        const at = now().toISOString();
        const outcome = connectOutcome(request, accounts.map((connection) => connection.connectionId), at);
        if (outcome.status === "pending") continue;
        try {
          const continuation = await deps.transact(ownerId, async (tx) => {
            await createBotConnectRequestsRepository(tx.db).reconcile({
              ownerId, requestId: request.requestId, baseRevision: request.revision,
              currentConnectionIds: accounts.map((connection) => connection.connectionId), now: at,
            }, tx.db);
            const interaction = await createBotInteractionsRepository(tx.db).get({ ownerId, interactionId: request.interactionId }, tx.db);
            // Expiry is announced by the question sweep; a request already answered needs nothing more.
            if (outcome.status === "expired" || !interaction || interaction.status !== "pending") return undefined;
            if (outcome.status === "completed") {
              const connection = accounts.find((account) => account.connectionId === outcome.connectionId)!;
              const { resolved, text } = await grantAndResolve(tx, interaction, connection, at);
              return resolved.blocking ? continuationFor(resolved, text) : undefined;
            }
            await askWhich(tx, interaction, accounts.filter((account) => outcome.connectionIds.includes(account.connectionId)), at);
            return undefined;
          });
          if (continuation) continuations.push(continuation);
        } catch (error: unknown) {
          console.warn("[bots] connection reconciliation failed:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      return continuations;
    },

    /** Resolved connections awaiting Chat admission survive process restarts. */
    async pendingContinuations(ownerId: string): Promise<BotContinuation[]> {
      const at = now().toISOString();
      const rows = await deps.transact(ownerId, (tx) => tx.db.selectFrom("bot_interactions")
        .select(["interaction_id", "chat_id", "resolution"])
        .where("owner_id", "=", ownerId).where("kind", "=", "connect_request").where("status", "=", "resolved")
        .where(sql<boolean>`resolution ? 'continuation'`)
        .where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt')`)
        .where(sql<boolean>`(resolution->>'continuationRetryAt' IS NULL OR resolution->>'continuationRetryAt' <= ${at})`)
        .orderBy("created_at", "asc").limit(MAX_CONTINUATIONS_PER_OWNER).execute());
      return rows.flatMap((row) => {
        const text = row.resolution?.continuation;
        return typeof text === "string" && text.length > 0
          ? [{ chatId: row.chat_id, clientRequestId: `req_answer_${row.interaction_id}`, text }]
          : [];
      });
    },
    /** Admission is idempotent under the interaction-derived request ID. */
    async ackContinuation(ownerId: string, clientRequestId: string): Promise<void> {
      const id = BotInteractionIdSchema.safeParse(clientRequestId.replace(/^req_answer_/, ""));
      if (!id.success || clientRequestId !== `req_answer_${id.data}`) throw new BotInteractionError("invalid_request");
      const at = now().toISOString();
      await deps.transact(ownerId, (tx) => tx.db.updateTable("bot_interactions")
        .set({ resolution: sql`jsonb_set(resolution, '{continuationAdmittedAt}', to_jsonb(${at}::text), true)` })
        .where("owner_id", "=", ownerId).where("interaction_id", "=", id.data)
        .where("kind", "=", "connect_request").where("status", "=", "resolved")
        .where(sql<boolean>`resolution ? 'continuation'`).where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt')`)
        .execute());
    },
    /** Delay a failed admission so one owner cannot monopolize every bounded pass. */
    async deferContinuation(ownerId: string, clientRequestId: string): Promise<void> {
      const id = BotInteractionIdSchema.safeParse(clientRequestId.replace(/^req_answer_/, ""));
      if (!id.success || clientRequestId !== `req_answer_${id.data}`) throw new BotInteractionError("invalid_request");
      const retryAt = new Date(now().getTime() + CONTINUATION_RETRY_MS).toISOString();
      await deps.transact(ownerId, (tx) => tx.db.updateTable("bot_interactions")
        .set({ resolution: sql`jsonb_set(resolution, '{continuationRetryAt}', to_jsonb(${retryAt}::text), true)` })
        .where("owner_id", "=", ownerId).where("interaction_id", "=", id.data)
        .where("kind", "=", "connect_request").where("status", "=", "resolved")
        .where(sql<boolean>`resolution ? 'continuation'`).where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt')`)
        .execute());
    },

    /** Owners with started requests or due continuations, a bounded number per pass. */
    async ownersWithPending(): Promise<string[]> {
      const at = now().toISOString();
      const [requests, continuations] = await deps.transact(PASS_OWNER, async (tx) => {
        const requests = await tx.db.selectFrom("bot_connect_requests")
          .select("owner_id").select((eb) => eb.fn.min("requested_at").as("oldest"))
          .where("status", "=", "pending").groupBy("owner_id")
          .orderBy("oldest", "asc").orderBy("owner_id", "asc").limit(MAX_OWNERS_PER_PASS).execute();
        const continuations = await tx.db.selectFrom("bot_interactions")
          .select("owner_id").select((eb) => eb.fn.min("created_at").as("oldest"))
          .where("kind", "=", "connect_request").where("status", "=", "resolved")
          .where(sql<boolean>`resolution ? 'continuation'`)
          .where(sql<boolean>`NOT (resolution ? 'continuationAdmittedAt')`)
          .where(sql<boolean>`(resolution->>'continuationRetryAt' IS NULL OR resolution->>'continuationRetryAt' <= ${at})`)
          .groupBy("owner_id").orderBy("oldest", "asc").orderBy("owner_id", "asc")
          .limit(MAX_OWNERS_PER_PASS).execute();
        return [requests, continuations] as const;
      });
      const oldest = new Map<string, number>();
      for (const row of [...requests, ...continuations]) {
        const time = new Date(row.oldest).getTime();
        oldest.set(row.owner_id, Math.min(oldest.get(row.owner_id) ?? time, time));
      }
      return [...oldest].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
        .slice(0, MAX_OWNERS_PER_PASS).map(([ownerId]) => ownerId);
    },
  };
}

export type BotConnections = ReturnType<typeof createBotConnections>;
