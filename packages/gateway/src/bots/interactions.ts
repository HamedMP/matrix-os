/**
 * Bot questions (spec 536, contracts/bots-http-api.md). A bot asks through
 * the `interaction.create` tool; the owner is the responder. A blocking
 * question ends the bot's turn and keeps its task waiting; the answer is
 * recorded and then continues the same task as the owner's next message,
 * admitted once under a request ID derived from the interaction. Account
 * choices, connection requests, and approvals are created by the gateway
 * when a bot needs access or approval; their resolution steps are injected.
 *
 * State changes and their Chat events commit in one transaction. A person
 * who is not the responder learns nothing about an interaction.
 */
import { isDeepStrictEqual } from "node:util";
import {
  BotInteractionIdSchema,
  CanonicalChatIdSchema,
  ResolveBotInteractionRequestSchema,
  ResolveBotInteractionResponseSchema,
  type BotInteraction,
  type BotToolRequest,
  type BotToolResult,
  type ResolveBotInteractionResponse,
} from "@matrix-os/contracts";
import { createBotInteractionContinuations } from "./interaction-continuations.js";
import { BotBrokerActionError } from "./broker-actions.js";
import type { BotStateTransaction, BotStateTransactions } from "./events.js";
import { createBotInteractionsRepository, type BotInteractionRecord } from "./repositories/interactions.js";
import { BotStateError } from "./repositories/shared.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";

const QUESTION_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_ANSWER_CHARS = 30_000;
const MAX_OWNERS_PER_SWEEP = 16;
/** The sweep's read publishes nothing, so no owner scope applies to it. */
const SWEEP_OWNER = "bot-interaction-sweep";

export type BotInteractionErrorCode = "invalid_request" | "not_found" | "conflict" | "expired" | "unavailable";

/** Allowlisted failures; the route maps each to one status and a generic message. */
export class BotInteractionError extends Error {
  constructor(readonly code: BotInteractionErrorCode) {
    super(`Bot interaction refused: ${code}`);
    this.name = "BotInteractionError";
  }
}

/** The answer, posted as the owner's message so the waiting task continues with it. */
export interface BotContinuation {
  chatId: string;
  clientRequestId: string;
  text: string;
}

type QuestionPayload = Extract<Extract<BotToolRequest, { capability: "interaction.create" }>["args"]["payload"], { kind: "question" }>;
type QuestionAnswer = { answer?: string; structuredAnswers?: Record<string, string[]> };

function event(interaction: BotInteractionRecord) {
  return { interactionId: interaction.interactionId, chatId: interaction.chatId, status: interaction.status, revision: interaction.revision };
}

/** Renders the answer against the questions it answers; unknown question IDs were refused earlier. */
export function renderAnswer(payload: QuestionPayload, answer: QuestionAnswer): string {
  const lines: string[] = [];
  for (const question of payload.questions) {
    const chosen = answer.structuredAnswers?.[question.questionId];
    if (chosen) lines.push(`${question.question}\n${chosen.join(", ")}`);
  }
  if (answer.answer) lines.push(answer.answer);
  return lines.join("\n\n").slice(0, MAX_ANSWER_CHARS);
}

function mapStateError(error: unknown): never {
  if (error instanceof BotStateError) {
    if (error.code === "not_found") throw new BotInteractionError("not_found");
    if (error.code === "revision_conflict" || error.code === "invalid_transition") throw new BotInteractionError("conflict");
    if (error.code === "invalid_input" || error.code === "too_large") throw new BotInteractionError("invalid_request");
  }
  throw error;
}

/** Resolution steps for the kinds that grant or authorize something. */
export interface BotInteractionHandlers {
  /** Grants the chosen account and returns the continuation text. */
  chooseAccount(tx: BotStateTransaction, interaction: BotInteractionRecord, connectionId: string, responderId: string): Promise<string>;
  /** Records the decision on the approval and returns the continuation text. */
  decideApproval(tx: BotStateTransaction, interaction: BotInteractionRecord, decision: "approve" | "deny"): Promise<string>;
  /** Starts a connection; its network step runs outside any transaction. */
  startConnect?(responderId: string, chatId: string, interactionId: string, baseRevision: number): Promise<{
    response: ResolveBotInteractionResponse;
    continuation?: BotContinuation;
  }>;
}

export function createBotInteractionService(deps: { transact: BotStateTransactions; handlers?: BotInteractionHandlers; now?: () => Date }) {
  const now = () => deps.now?.() ?? new Date();

  function project(interaction: BotInteractionRecord, viewerId: string): BotInteraction {
    return {
      interactionId: interaction.interactionId,
      chatId: interaction.chatId,
      agentId: interaction.botId,
      taskId: interaction.taskId,
      kind: interaction.kind,
      blocking: interaction.blocking,
      status: interaction.status,
      expiresAt: interaction.expiresAt,
      revision: interaction.revision,
      // Only the designated responder sees what was asked.
      ...(interaction.responderActorId === viewerId ? { payload: interaction.payload as BotInteraction["payload"] } : {}),
    };
  }

  return {
    ackContinuation: createBotInteractionContinuations(deps).ackContinuation,
    /** `interaction.create` from a bot run. Questions only in M1 L9a. */
    async createFromTool(binding: BotRuntimeBinding, args: Extract<BotToolRequest, { capability: "interaction.create" }>["args"]): Promise<BotToolResult> {
      if (args.payload.kind !== "question") throw new BotBrokerActionError("not_granted");
      // A bot never collects a secret through Chat.
      if (args.payload.questions.some((question) => question.secret)) throw new BotBrokerActionError("invalid_arguments");
      const at = now();
      try {
        await deps.transact(binding.ownerId, async (tx) => {
          const { interaction, expired } = await createBotInteractionsRepository(tx.db).create({
            ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId, taskId: binding.taskId,
            kind: "question", payload: args.payload, responderActorId: binding.ownerId, blocking: args.blocking,
            expiresAt: new Date(at.getTime() + QUESTION_LIFETIME_MS).toISOString(), now: at.toISOString(),
          }, tx.db);
          for (const overdue of expired) await tx.publish(overdue.chatId, "interaction.resolved", event(overdue));
          await tx.publish(interaction.chatId, "interaction.requested", {
            interactionId: interaction.interactionId, chatId: interaction.chatId, agentId: interaction.botId,
            kind: interaction.kind, blocking: interaction.blocking, expiresAt: interaction.expiresAt, revision: interaction.revision,
          });
        });
      } catch (error: unknown) {
        if (error instanceof BotStateError) {
          // One blocking question per task; the cap bounds what one owner can be asked at once.
          if (error.code === "conflict" || error.code === "invalid_input" || error.code === "too_large") throw new BotBrokerActionError("invalid_arguments");
          if (error.code === "capacity_exceeded") throw new BotBrokerActionError("budget_exhausted");
          if (error.code === "not_found") throw new BotBrokerActionError("stale_generation");
        }
        throw error;
      }
      return {
        ok: true,
        content: [{
          type: "text",
          text: args.blocking
            ? "The owner has your question. End your turn now; their answer arrives as their next message."
            : "The owner has your question. Continue with work that does not depend on the answer.",
        }],
      };
    },

    /** Pending questions in one chat, as the viewer may see them. */
    async listPending(viewerId: string, chatIdValue: string): Promise<BotInteraction[]> {
      const chatId = CanonicalChatIdSchema.safeParse(chatIdValue);
      if (!chatId.success) throw new BotInteractionError("invalid_request");
      const pending = await deps.transact(viewerId, (tx) =>
        createBotInteractionsRepository(tx.db).listPending({ ownerId: viewerId, chatId: chatId.data, now: now().toISOString() }, tx.db));
      return pending.map((interaction) => project(interaction, viewerId));
    },

    /**
     * Records the responder's answer at the interaction's revision. Every answered
     * interaction returns the continuation to admit; busy Chats queue it. Repeating the same answer
     * after it was recorded returns the same result, so a client can retry a
     * request whose continuation failed. The durable delivery pass also retries
     * unacknowledged resolutions after queue pressure or a process restart.
     */
    async resolve(responderId: string, chatIdValue: string, interactionIdValue: string, body: unknown): Promise<{
      response: ResolveBotInteractionResponse;
      continuation?: BotContinuation;
    }> {
      const chatId = CanonicalChatIdSchema.safeParse(chatIdValue);
      const interactionId = BotInteractionIdSchema.safeParse(interactionIdValue);
      const request = ResolveBotInteractionRequestSchema.safeParse(body);
      if (!chatId.success || !interactionId.success || !request.success) throw new BotInteractionError("invalid_request");
      const input = request.data;
      // Starting a connection runs its network step before any transaction (L9c).
      if (input.kind === "connect_request" && input.action === "start") {
        if (!deps.handlers?.startConnect) throw new BotInteractionError("invalid_request");
        return deps.handlers.startConnect(responderId, chatId.data, interactionId.data, input.baseRevision);
      }
      const requested: Record<string, unknown> = input.kind === "question"
        ? { ...(input.answer !== undefined ? { answer: input.answer } : {}), ...(input.structuredAnswers !== undefined ? { structuredAnswers: input.structuredAnswers } : {}) }
        : input.kind === "account_choice" ? { connectionId: input.connectionId }
        : input.kind === "approval" ? { decision: input.decision }
        : { action: input.action };
      const at = now().toISOString();
      return deps.transact(responderId, async (tx) => {
        const repository = createBotInteractionsRepository(tx.db);
        const current = await repository.get({ ownerId: responderId, interactionId: interactionId.data }, tx.db);
        if (!current || current.chatId !== chatId.data || current.responderActorId !== responderId) throw new BotInteractionError("not_found");
        if (current.kind !== input.kind) throw new BotInteractionError("invalid_request");
        const respond = (interaction: BotInteractionRecord, text: string | undefined) => ({
          response: ResolveBotInteractionResponseSchema.parse({ interaction: { interactionId: interaction.interactionId, status: interaction.status, revision: interaction.revision } }),
          ...(text ? { continuation: { chatId: interaction.chatId, clientRequestId: `req_answer_${interaction.interactionId}`, text } } : {}),
        });
        const { continuation: storedText, continuationAdmittedAt, continuationRetryAt: _retryAt, ...stored } = current.resolution ?? {};
        if (current.status === "resolved" && current.revision === input.baseRevision + 1 && isDeepStrictEqual(stored, requested)) {
          const replayText = typeof storedText === "string" ? storedText
            : current.kind === "question" ? renderAnswer(current.payload as QuestionPayload, requested as QuestionAnswer) : undefined;
          return respond(current, continuationAdmittedAt ? undefined : replayText);
        }
        if (current.status === "expired" || (current.status === "pending" && Date.parse(current.expiresAt) <= Date.parse(at))) {
          throw new BotInteractionError("expired");
        }
        if (current.status !== "pending") throw new BotInteractionError("conflict");
        if (current.revision !== input.baseRevision) throw new BotInteractionError("conflict");
        let text: string;
        if (input.kind === "question") {
          const payload = current.payload as QuestionPayload;
          const known = new Set(payload.questions.map((question) => question.questionId));
          if (Object.keys(input.structuredAnswers ?? {}).some((id) => !known.has(id))) throw new BotInteractionError("invalid_request");
          text = renderAnswer(payload, requested as QuestionAnswer);
        } else if (input.kind === "account_choice") {
          if (!deps.handlers) throw new BotInteractionError("unavailable");
          text = await deps.handlers.chooseAccount(tx, current, input.connectionId, responderId);
        } else if (input.kind === "approval") {
          if (!deps.handlers) throw new BotInteractionError("unavailable");
          text = await deps.handlers.decideApproval(tx, current, input.decision);
        } else {
          const service = String((current.payload as { service?: unknown }).service ?? "that service");
          text = `The owner chose not to connect ${service}. Continue without it, and do not ask again in this task.`;
        }
        let resolved: BotInteractionRecord;
        try {
          resolved = await repository.resolve({
            ownerId: responderId, interactionId: current.interactionId, baseRevision: input.baseRevision,
            responderActorId: responderId, resolution: { ...requested, continuation: text }, now: at,
          }, tx.db);
        } catch (error: unknown) {
          return mapStateError(error);
        }
        await tx.publish(resolved.chatId, "interaction.resolved", event(resolved));
        return respond(resolved, text);
      });
    },

    /**
     * The owner replied in Chat instead of answering the form: the reply
     * answers the task's pending question, so the waiting task continues.
     */
    async answerWithMessage(input: { ownerId: string; taskId: string; chatId: string; text: string }): Promise<void> {
      const at = now().toISOString();
      await deps.transact(input.ownerId, async (tx) => {
        const repository = createBotInteractionsRepository(tx.db);
        const pending = (await repository.listPending({ ownerId: input.ownerId, chatId: input.chatId, now: at }, tx.db))
          // Only the question the task waits on; other open questions keep their own answers.
          .filter((interaction) => interaction.taskId === input.taskId && interaction.kind === "question"
            && interaction.blocking && interaction.responderActorId === input.ownerId);
        for (const interaction of pending) {
          const resolved = await repository.resolve({
            ownerId: input.ownerId, interactionId: interaction.interactionId, baseRevision: interaction.revision,
            responderActorId: input.ownerId, resolution: { answer: input.text.slice(0, MAX_ANSWER_CHARS), via: "message" }, now: at,
          }, tx.db).catch(mapStateError);
          await tx.publish(resolved.chatId, "interaction.resolved", event(resolved));
        }
      });
    },

    /** Expires overdue questions for every owner that has some, a bounded number of owners per pass. */
    async expireAllDue(): Promise<number> {
      const at = now().toISOString();
      // Owners with the oldest overdue questions first, so no owner waits behind others indefinitely.
      const owners = await deps.transact(SWEEP_OWNER, (tx) => tx.db.selectFrom("bot_interactions")
        .select((eb) => ["owner_id", eb.fn.min("expires_at").as("oldest")])
        .where("status", "=", "pending").where("expires_at", "<=", at)
        .groupBy("owner_id").orderBy("oldest", "asc").limit(MAX_OWNERS_PER_SWEEP).execute());
      let expired = 0;
      for (const { owner_id: ownerId } of owners) expired += await this.expireDue(ownerId);
      return expired;
    },
    /** Expires overdue questions in a bounded batch and announces each. */
    async expireDue(ownerId: string): Promise<number> {
      return deps.transact(ownerId, async (tx) => {
        const expired = await createBotInteractionsRepository(tx.db).expireDue({ ownerId, now: now().toISOString() }, tx.db);
        for (const interaction of expired) await tx.publish(interaction.chatId, "interaction.resolved", event(interaction));
        return expired.length;
      });
    },
  };
}

export type BotInteractionService = ReturnType<typeof createBotInteractionService>;
