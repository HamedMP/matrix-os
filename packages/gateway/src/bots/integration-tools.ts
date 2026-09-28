/**
 * Integration tools for bots (spec 536, research R5, technical-design
 * "Computer and Tool Boundaries"). A bot uses an account only through a
 * live grant for the exact service, account, audience, and effect, and only
 * for effects its recipe declares. Reads run on the read-only route. A write
 * or send needs the owner's approval of that exact call: the first attempt
 * asks, and after approval a later run of the same task claims it once.
 *
 * When access is missing the gateway asks the owner itself (an account
 * choice among connected accounts, or a connection request) and the task
 * waits; a request the owner declined is not repeated in the same task. Each
 * request and its Chat event commit together, and no transaction spans a
 * network call.
 */
import { createHash } from "node:crypto";
import type { BotEffect, BotToolRequest, BotToolResult } from "@matrix-os/contracts";
import type { ChatAgentStore } from "../chat/agent-store.js";
import { getAction, getService } from "../integrations/registry.js";
import { BotBrokerActionError } from "./broker-actions.js";
import type { BotStateTransaction, BotStateTransactions } from "./events.js";
import { BotIntegrationError, type BotIntegrationClient, type BotIntegrationConnection } from "./integration-client.js";
import type { BotRecipeCatalog } from "./recipe-catalog.js";
import { createBotApprovalsRepository } from "./repositories/approvals.js";
import { createBotGrantsRepository, type BotGrantRecord } from "./repositories/grants.js";
import { createBotInteractionsRepository } from "./repositories/interactions.js";
import { BotStateError, newBotStateId } from "./repositories/shared.js";
import type { BotRuntimeBinding } from "./runtime-registry.js";

const AUDIENCE = "direct";
const APPROVAL_TOOL = "integration.call";
const REQUEST_LIFETIME_MS = 24 * 60 * 60_000;
const CONNECT_LIFETIME_MS = 15 * 60_000;
const MAX_RESULT_CHARS = 60 * 1024;
const MAX_PREVIEW_CHARS = 3_000;
const MAX_ACCOUNT_OPTIONS = 10;

type CallArgs = Extract<BotToolRequest, { capability: "integration.call" }>["args"];
type InventoryArgs = Extract<BotToolRequest, { capability: "integration.inventory" }>["args"];

function text(value: string): BotToolResult {
  const content: Array<{ type: "text"; text: string }> = [];
  for (let index = 0; index < Math.max(1, value.length) && content.length < 4; index += 60 * 1024) {
    content.push({ type: "text", text: value.slice(index, index + 60 * 1024) });
  }
  return { ok: true, content };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** A write whose action sends something to other people is a `send`. */
export function effectOf(service: string, action: string): BotEffect | undefined {
  const definition = getAction(service, action);
  if (!definition) return undefined;
  if (definition.risk === "read") return "read";
  return /(^|_)(send|reply|post|publish)(_|$)/.test(action) ? "send" : "write";
}

export function approvalDigest(args: Pick<CallArgs, "service" | "action" | "connectionId" | "params">): string {
  return createHash("sha256").update(canonicalJson({
    service: args.service, action: args.action, connectionId: args.connectionId, params: args.params,
  })).digest("hex");
}

function serviceName(service: string): string {
  return getService(service)?.name ?? service;
}

export function createBotIntegrationTools(deps: {
  client: BotIntegrationClient;
  transact: BotStateTransactions;
  recipes: BotRecipeCatalog;
  agents: Pick<ChatAgentStore, "get">;
  now?: () => Date;
}) {
  const now = () => deps.now?.() ?? new Date();

  /** The effects the bot's recipe declares for a service; nothing for an undeclared service. */
  async function declaredEffects(ownerId: string, botId: string, service: string): Promise<readonly BotEffect[]> {
    const agent = await deps.agents.get({ type: "personal", ownerId }, botId);
    if (!agent?.recipeRef) return [];
    try {
      return deps.recipes.resolve(agent.recipeRef).integrations.find((entry) => entry.service === service)?.effects ?? [];
    } catch (error: unknown) {
      console.warn("[bots] recipe unavailable for grants:", error instanceof Error ? error.name : "UnknownError");
      return [];
    }
  }

  async function inventory(ownerId: string, signal?: AbortSignal): Promise<BotIntegrationConnection[]> {
    try {
      return await deps.client.inventory(ownerId, signal);
    } catch (error: unknown) {
      if (error instanceof BotIntegrationError) throw new BotBrokerActionError("unavailable");
      throw error;
    }
  }

  /**
   * Asks the owner for access in this task, once. Answers with what the bot
   * should do next; the task waits while the request is open.
   */
  async function requestAccess(tx: BotStateTransaction, binding: BotRuntimeBinding, service: string, effects: readonly BotEffect[], connected: readonly BotIntegrationConnection[]): Promise<string> {
    const interactions = createBotInteractionsRepository(tx.db);
    const at = now();
    const earlier = await tx.db.selectFrom("bot_interactions").select(["kind", "status", "blocking"])
      .where("owner_id", "=", binding.ownerId).where("task_id", "=", binding.taskId)
      .where("kind", "in", ["account_choice", "connect_request"])
      .where(({ eb, ref }) => eb(ref("payload", "->>").key("service" as never), "=", service))
      .execute();
    if (earlier.some((row) => row.status === "resolved" || row.status === "cancelled")) {
      return `The owner did not give access to ${serviceName(service)} in this task. Continue without it and do not ask again.`;
    }
    if (earlier.some((row) => row.status === "pending")) {
      return `The owner has not answered the access request for ${serviceName(service)} yet. End your turn now.`;
    }
    const expiresAt = (lifetime: number) => new Date(at.getTime() + lifetime).toISOString();
    const options = connected.filter((connection) => connection.service === service).slice(0, MAX_ACCOUNT_OPTIONS);
    const payload = options.length >= 2
      ? { kind: "account_choice" as const, service, options: options.map((option) => ({ connectionId: option.connectionId, label: option.label })) }
      : {
        kind: "connect_request" as const, service, access: [...effects],
        benefit: `This bot needs ${effects.join(" and ")} access to ${serviceName(service)} to continue this task.`,
        connectRequestId: newBotStateId("cr"),
      };
    try {
      const { interaction, expired } = await interactions.create({
        ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId, taskId: binding.taskId,
        kind: payload.kind, payload, responderActorId: binding.ownerId, blocking: true,
        expiresAt: expiresAt(payload.kind === "connect_request" ? CONNECT_LIFETIME_MS : REQUEST_LIFETIME_MS), now: at.toISOString(),
      }, tx.db);
      for (const overdue of expired) {
        await tx.publish(overdue.chatId, "interaction.resolved", { interactionId: overdue.interactionId, chatId: overdue.chatId, status: overdue.status, revision: overdue.revision });
      }
      await tx.publish(interaction.chatId, "interaction.requested", {
        interactionId: interaction.interactionId, chatId: interaction.chatId, agentId: interaction.botId,
        kind: interaction.kind, blocking: true, expiresAt: interaction.expiresAt, revision: interaction.revision,
      });
    } catch (error: unknown) {
      // Another blocking request is already open for this task.
      if (error instanceof BotStateError && error.code === "conflict") return "The owner already has a request from you open. End your turn now.";
      if (error instanceof BotStateError && error.code === "capacity_exceeded") throw new BotBrokerActionError("budget_exhausted");
      throw error;
    }
    return payload.kind === "account_choice"
      ? `The owner has been asked which ${serviceName(service)} account to use. End your turn now; the answer arrives as their next message.`
      : `The owner has been asked to connect ${serviceName(service)}. End your turn now; you will hear back when it is connected.`;
  }

  /** Claims an approval of this exact call, or asks for one. */
  async function approved(binding: BotRuntimeBinding, args: CallArgs, grant: BotGrantRecord, preview: string): Promise<{ approved: true } | { approved: false; message: string }> {
    const argsHash = approvalDigest(args);
    const account = `${args.service}:${grant.accountLabel}`.slice(0, 256);
    const policy = { taskId: binding.taskId, tool: APPROVAL_TOOL, argsHash, account, audience: AUDIENCE, policyRevision: grant.revision };
    const at = now();
    return deps.transact(binding.ownerId, async (tx) => {
      const approvals = createBotApprovalsRepository(tx.db);
      const open = await approvals.findOpen({ ownerId: binding.ownerId, taskId: binding.taskId, tool: APPROVAL_TOOL, argsHash }, tx.db);
      if (open?.status === "approved") {
        const claim = await approvals.claim({ ownerId: binding.ownerId, approvalId: open.approvalId, ...policy, now: at.toISOString() }, tx.db);
        if (claim.status === "claimed") return { approved: true as const };
      } else if (open?.status === "pending") {
        return { approved: false as const, message: "The owner has not decided on this action yet. End your turn now." };
      }
      try {
        const { interaction } = await createBotInteractionsRepository(tx.db).create({
          ownerId: binding.ownerId, botId: binding.botId, chatId: binding.chatId, taskId: binding.taskId, kind: "approval",
          payload: {
            kind: "approval", tool: APPROVAL_TOOL, argsDigest: argsHash,
            account: { service: args.service, label: grant.accountLabel }, audience: AUDIENCE, preview, policyRevision: grant.revision,
          },
          responderActorId: binding.ownerId, blocking: true,
          expiresAt: new Date(at.getTime() + REQUEST_LIFETIME_MS).toISOString(), now: at.toISOString(),
        }, tx.db);
        await approvals.create({
          ownerId: binding.ownerId, approvalId: interaction.interactionId, botId: binding.botId, runId: binding.runId, ...policy,
          expiresAt: interaction.expiresAt, now: at.toISOString(),
        }, tx.db);
        await tx.publish(interaction.chatId, "interaction.requested", {
          interactionId: interaction.interactionId, chatId: interaction.chatId, agentId: interaction.botId,
          kind: "approval", blocking: true, expiresAt: interaction.expiresAt, revision: interaction.revision,
        });
      } catch (error: unknown) {
        if (error instanceof BotStateError && error.code === "conflict") {
          return { approved: false as const, message: "The owner already has a request from you open. End your turn now." };
        }
        throw error;
      }
      return { approved: false as const, message: `The owner has been asked to approve: ${preview}\nEnd your turn now; their decision arrives as their next message.` };
    });
  }

  return {
    /** `integration.inventory`: what the bot may use, per declared service. */
    async inventory(binding: BotRuntimeBinding, args: InventoryArgs, signal?: AbortSignal): Promise<BotToolResult> {
      const agent = await deps.agents.get({ type: "personal", ownerId: binding.ownerId }, binding.botId);
      let services: string[] = [];
      if (agent?.recipeRef) {
        try {
          services = deps.recipes.resolve(agent.recipeRef).integrations.map((entry) => entry.service);
        } catch (error: unknown) {
          console.warn("[bots] recipe unavailable for inventory:", error instanceof Error ? error.name : "UnknownError");
        }
      }
      if (args.service) services = services.filter((service) => service === args.service);
      if (services.length === 0) return text("This bot has no connected services for this task.");
      const connected = await inventory(binding.ownerId, signal);
      const grants = await deps.transact(binding.ownerId, (tx) => createBotGrantsRepository(tx.db).listLive({
        ownerId: binding.ownerId, botId: binding.botId, audience: AUDIENCE, now: now().toISOString(),
      }, tx.db));
      const lines = services.map((service) => {
        const granted = grants.filter((grant) => grant.service === service
          && connected.some((connection) => connection.connectionId === grant.connectionId));
        if (granted.length > 0) {
          return `${serviceName(service)} (${service}): ${granted.map((grant) =>
            `account "${grant.accountLabel}", connection ${grant.connectionId}, allowed: ${grant.effects.join(", ")}`).join("; ")}`;
        }
        const count = connected.filter((connection) => connection.service === service).length;
        return `${serviceName(service)} (${service}): ${count > 0 ? "connected, but this bot has no access yet" : "not connected"}`;
      });
      return text(lines.join("\n"));
    },

    /** `integration.call`: one action on a granted account. */
    async call(binding: BotRuntimeBinding, args: CallArgs, signal?: AbortSignal): Promise<BotToolResult> {
      const effect = effectOf(args.service, args.action);
      if (!effect) throw new BotBrokerActionError("invalid_arguments");
      const declared = await declaredEffects(binding.ownerId, binding.botId, args.service);
      // A bot never exceeds what its recipe declares for a service.
      if (!declared.includes(effect)) throw new BotBrokerActionError("denied");
      const connected = await inventory(binding.ownerId, signal);
      const at = now().toISOString();
      const grant = await deps.transact(binding.ownerId, (tx) => createBotGrantsRepository(tx.db).findUsable({
        ownerId: binding.ownerId, botId: binding.botId, service: args.service, connectionId: args.connectionId,
        audience: AUDIENCE, effect, now: at,
      }, tx.db));
      const account = connected.filter((connection) => connection.service === args.service && connection.label === grant?.accountLabel);
      if (!grant || account.length !== 1 || account[0]!.connectionId !== args.connectionId) {
        return text(await deps.transact(binding.ownerId, (tx) => requestAccess(tx, binding, args.service, declared, connected)));
      }
      if (effect !== "read") {
        const preview = `${serviceName(args.service)}: ${args.action} on "${grant.accountLabel}" with ${canonicalJson(args.params)}`.slice(0, MAX_PREVIEW_CHARS);
        const decision = await approved(binding, args, grant, preview);
        if (!decision.approved) return text(decision.message);
      }
      try {
        const result = await deps.client.call(binding.ownerId, {
          service: args.service, action: args.action, label: grant.accountLabel, params: args.params, read: effect === "read",
        }, signal);
        const body = JSON.stringify(result.data) ?? "null";
        const shown = body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n[${body.length - MAX_RESULT_CHARS} characters left out.]` : body;
        return text(result.summary ? `${result.summary}\n\n${shown}` : shown);
      } catch (error: unknown) {
        if (!(error instanceof BotIntegrationError)) throw error;
        if (signal?.aborted) throw new BotBrokerActionError("timeout");
        if (error.code === "denied") throw new BotBrokerActionError("denied");
        if (error.code === "missing") throw new BotBrokerActionError("not_granted");
        if (error.code === "invalid") throw new BotBrokerActionError("invalid_arguments");
        throw new BotBrokerActionError("unavailable");
      }
    },

    declaredEffects,
  };
}

export type BotIntegrationTools = ReturnType<typeof createBotIntegrationTools>;
