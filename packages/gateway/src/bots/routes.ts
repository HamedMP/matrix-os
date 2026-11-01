import {createBotRoutineRoutes} from "./routine-routes.js";
/**
 * Bots HTTP routes (spec 536, contracts/bots-http-api.md). Every route
 * authenticates the request principal; a bot never stands in for a person.
 * Bodies are bounded and strictly validated, errors come from one mapper
 * with allowlisted codes and generic messages, and responses are private.
 */
import { BotChatBindingResponseSchema, BotDirectChatResponseSchema, BotGrantIdSchema, BotInteractionIdSchema, BotMemoryItemIdSchema, BotRecipeListResponseSchema, BotTaskListResponseSchema, CanonicalChatIdSchema, ChatAgentIdSchema, RecoverManagedCustomBotRequestSchema, type BotTaskSummary } from "@matrix-os/contracts";
import { BotEntryError } from "./custom-direct-chat.js";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod/v4";
import { bodyLimit } from "hono/body-limit";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import type { BotContinuationAdmitter } from "./continuations.js";
import { BotInstantiationError, type BotInstantiation } from "./instantiation.js";
import { BotInteractionError, type BotInteractionService } from "./interactions.js";
import { BotMemoryError, type BotMemoryService } from "./memory-service.js";
import { BotGrantError, type BotGrantService } from "./grants-service.js";
import { BotAuthorityError, type BotAuthority } from "./authority.js";
import type { BotRecipeCatalog } from "./recipe-catalog.js";
import type { BotChatLookup } from "../chat/agent-context.js";
import { createBotProviderConnectionRoutes } from './provider-connection-routes.js';
import { createChatGptPlanPeerRoutes } from './chatgpt-plan-peer-routes.js';
import type { ChatGptPlanPeers } from './chatgpt-plan-peers.js';
import type { BotProviderConnectionsService } from './provider-connections.js';
import { ManagedCustomRecoveryError, type ManagedCustomRecovery } from "./managed-custom-recovery.js";

const MAX_BODY_BYTES = 64 * 1024;
const includeRecoverySchema = z.enum(["true", "false"]).optional();
const includeRunIdsSchema = z.enum(["true", "false"]).optional();

type ErrorCode = "invalid_request" | "not_found" | "conflict" | "expired" | "rate_limited" | "unavailable";
const ERRORS: Record<ErrorCode, { status: 400 | 404 | 409 | 410 | 429 | 503; message: string }> = {
  invalid_request: { status: 400, message: "The request is invalid." },
  not_found: { status: 404, message: "Not found." },
  conflict: { status: 409, message: "This changed since you loaded it. Refresh and try again." },
  expired: { status: 410, message: "This request has expired." },
  rate_limited: { status: 429, message: "You have reached the bot limit." },
  unavailable: { status: 503, message: "Bots are temporarily unavailable." },
};

function errorResponse(context: Context, code: ErrorCode) {
  context.header("Cache-Control", "private, no-store");
  return context.json({ code, message: ERRORS[code].message }, ERRORS[code].status);
}

export function createBotRoutes(options: {
  recipes?: Pick<BotRecipeCatalog, "list">;
  routines?: Pick<import("./routine-execution.js").BotRoutineExecution,"list"|"control"> & Partial<Pick<import("./routine-execution.js").BotRoutineExecution,"center"|"detail"|"requestEdit">>;
  botChats?: BotChatLookup;
  tasks?: (ownerId: string, chatId: string) => Promise<BotTaskSummary[]>;
  instantiation?: Pick<BotInstantiation, "instantiate"> & Partial<Pick<BotInstantiation, "createCustom">>;
  recovery?: ManagedCustomRecovery;
  interactions?: Pick<BotInteractionService, "listPending" | "resolve">;
  memory?: Pick<BotMemoryService, "forget" | "confirm">;
  grants?: Pick<BotGrantService, "revoke">;
  authority?: Pick<BotAuthority, "view">;
  providerConnections?: BotProviderConnectionsService;
  chatgptPlanPeers?: ChatGptPlanPeers;
  /** Admits the owner's answer as the next message; resolved at route registration. */
  admitContinuation?: BotContinuationAdmitter;
  getPrincipal(context: Context): RequestPrincipal;
}): Hono {
  const routes = new Hono();
  routes.route("/",createBotRoutineRoutes({routines:options.routines,getPrincipal:options.getPrincipal}));
  routes.route('/', createChatGptPlanPeerRoutes({ peers: options.chatgptPlanPeers, getPrincipal: options.getPrincipal }));
  routes.route('/', createBotProviderConnectionRoutes({ service: options.providerConnections, getPrincipal: options.getPrincipal }));
  const limit = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (context) => {
      context.header("Cache-Control", "private, no-store");
      return context.json({ code: "invalid_request", message: "The request is too large." }, 413);
    },
  });

  routes.onError((error: unknown, context) => {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error);
      if (mapped.log) console.warn("[bots] principal context unavailable:", error.name);
      return context.json(mapped.body, mapped.status);
    }
    if (error instanceof SyntaxError) return errorResponse(context, "invalid_request");
    if ((error instanceof BotInstantiationError || error instanceof ManagedCustomRecoveryError) && error.code === "invalid_request"
      && (error.reason === "prompt_too_large" || error.reason === "unsupported_skill")) {
      context.header("Cache-Control", "private, no-store");
      const message = error.reason === "prompt_too_large" ? "Shorten the instructions or remove recipe skills, then try again."
        : "Remove the unavailable skill before creating this Bot.";
      return context.json({ code: "invalid_request", reason: error.reason, message }, 400);
    }
    if (error instanceof ManagedCustomRecoveryError || error instanceof BotEntryError || error instanceof BotInstantiationError || error instanceof BotInteractionError || error instanceof BotMemoryError
      || error instanceof BotGrantError || error instanceof BotAuthorityError) {
      return errorResponse(context, error.code);
    }
    console.warn("[bots] request failed:", error instanceof Error ? error.name : "UnknownError");
    return errorResponse(context, "unavailable");
  });

  routes.post("/api/chat-agents/managed-custom", limit, async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.instantiation?.createCustom) return errorResponse(context, "unavailable");
    const result = await options.instantiation.createCustom(principal.userId, await context.req.json());
    context.header("Cache-Control", "private, no-store");
    return context.json(result, result.operation === "created" ? 201 : 200);
  });

  routes.post("/api/chat-agents/:agentId/recover-managed-custom", limit, async context => {
    const principal = options.getPrincipal(context);
    if (!options.recovery) return errorResponse(context, "unavailable");
    const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
    const body = RecoverManagedCustomBotRequestSchema.safeParse(await context.req.json());
    if (!agentId.success || !body.success) return errorResponse(context, "invalid_request");
    const result = await options.recovery.recover(principal.userId, agentId.data, body.data);
    context.header("Cache-Control", "private, no-store");
    return context.json(result, 200);
  });

  routes.post("/api/chat-agents/instantiate", limit, async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.instantiation) return errorResponse(context, "unavailable");
    const result = await options.instantiation.instantiate(principal.userId, await context.req.json());
    context.header("Cache-Control", "private, no-store");
    return context.json(result, result.operation === "created" ? 201 : 200);
  });

  routes.get("/api/chat-agents/bot-recipes", (context) => {
    options.getPrincipal(context);
    if (!options.recipes) return errorResponse(context, "unavailable");
    const recipes = options.recipes.list().map(({ recipeId, version, name, description, output }) =>
      ({ recipeId, version, name, description, output }));
    context.header("Cache-Control", "private, no-store");
    return context.json(BotRecipeListResponseSchema.parse({ recipes }));
  });

  routes.get("/api/chat-agents/:agentId/direct-chat", async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.botChats?.directChat) return errorResponse(context, "unavailable");
    const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
    if (!agentId.success) return errorResponse(context, "invalid_request");
    const chatId = await options.botChats.directChat({ type: "personal", ownerId: principal.userId }, agentId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json(BotChatBindingResponseSchema.parse({ chatId }));
  });

  routes.post("/api/chat-agents/:agentId/direct-chat", limit, async context => {
    const principal = options.getPrincipal(context);
    if (!options.botChats?.ensureDirectChat) return errorResponse(context, "unavailable");
    const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
    const body = z.object({}).strict().safeParse(await context.req.json());
    if (!agentId.success || !body.success) return errorResponse(context, "invalid_request");
    const chatId = await options.botChats.ensureDirectChat({ type: "personal", ownerId: principal.userId }, agentId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json(BotChatBindingResponseSchema.parse({ chatId }));
  });

  routes.get("/api/chats/:chatId/bot", async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.botChats) return errorResponse(context, "unavailable");
    const chatId = CanonicalChatIdSchema.safeParse(context.req.param("chatId"));
    if (!chatId.success) return errorResponse(context, "invalid_request");
    const agentId = await options.botChats.directBot({ type: "personal", ownerId: principal.userId }, chatId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json(BotDirectChatResponseSchema.parse({ agentId }));
  });

  routes.get("/api/chats/:chatId/bot-tasks", async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.tasks) return errorResponse(context, "unavailable");
    const chatId = CanonicalChatIdSchema.safeParse(context.req.param("chatId"));
    if (!chatId.success) return errorResponse(context, "invalid_request");
    const includeRunIds = includeRunIdsSchema.safeParse(context.req.query("includeRunIds"));
    if (!includeRunIds.success) return errorResponse(context, "invalid_request");
    const tasks = BotTaskListResponseSchema.parse({ tasks: await options.tasks(principal.userId, chatId.data) }).tasks;
    context.header("Cache-Control", "private, no-store");
    // Older clients parse task summaries strictly; extra identity is opt-in.
    return context.json({ tasks: includeRunIds.data === "true" ? tasks : tasks.map(task => {
      const legacy = { ...task };
      delete legacy.runId;
      return legacy;
    }) });
  });

  routes.get("/api/chats/:chatId/interactions", async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.interactions) return errorResponse(context, "unavailable");
    const chatId = CanonicalChatIdSchema.safeParse(context.req.param("chatId"));
    if (!chatId.success) return errorResponse(context, "invalid_request");
    const includeRecovery = includeRecoverySchema.safeParse(context.req.query("includeRecovery"));
    if (!includeRecovery.success) return errorResponse(context, "invalid_request");
    const interactions = includeRecovery.data === "true"
      ? await options.interactions.listPending(principal.userId, chatId.data, { includeRecovery: true })
      : await options.interactions.listPending(principal.userId, chatId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json({ interactions });
  });

  routes.post("/api/chats/:chatId/interactions/:interactionId/resolve", limit, async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.interactions || !options.admitContinuation) return errorResponse(context, "unavailable");
    const chatId = CanonicalChatIdSchema.safeParse(context.req.param("chatId"));
    const interactionId = BotInteractionIdSchema.safeParse(context.req.param("interactionId"));
    if (!chatId.success || !interactionId.success) return errorResponse(context, "invalid_request");
    const includeRecovery = includeRecoverySchema.safeParse(context.req.query("includeRecovery"));
    if (!includeRecovery.success) return errorResponse(context, "invalid_request");
    const request = await context.req.json();
    const { response, continuation } = await options.interactions.resolve(
      principal.userId, chatId.data, interactionId.data, request,
    );
    if (continuation) {
      // The answer is recorded either way; repeating this request retries the continuation.
      try {
        await options.admitContinuation(principal, continuation);
      } catch (error: unknown) {
        console.warn("[bots] answer continuation failed:", error instanceof Error ? error.name : "UnknownError");
        if (includeRecovery.data === "true" && (request?.kind === "question" || request?.kind === "resume")) {
          // A lost ACK may follow a committed admission. This branch only reads
          // the saved answer and exact request hash; never repeat admission here.
          try {
            const confirmed = await options.interactions.resolve(principal.userId, chatId.data, interactionId.data,
              { kind: "resume", baseRevision: response.interaction.revision });
            if (!confirmed.continuation) {
              context.header("Cache-Control", "private, no-store");
              return context.json(confirmed.response);
            }
          } catch (readError: unknown) {
            console.warn("[bots] continuation confirmation unavailable:", readError instanceof Error ? readError.name : "UnknownError");
          }
          context.header("Cache-Control", "private, no-store");
          return context.json({ ...response, continuationPending: true });
        }
        return errorResponse(context, "unavailable");
      }
    }
    context.header("Cache-Control", "private, no-store");
    return context.json(response);
  });

  for (const action of ["forget", "confirm"] as const) {
    routes.post(`/api/chat-agents/:agentId/memory/:itemId/${action}`, limit, async (context) => {
      const principal = options.getPrincipal(context);
      if (!options.memory) return errorResponse(context, "unavailable");
      const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
      const itemId = BotMemoryItemIdSchema.safeParse(context.req.param("itemId"));
      if (!agentId.success || !itemId.success) return errorResponse(context, "invalid_request");
      const result = await options.memory[action](
        principal.userId, agentId.data, itemId.data, await context.req.json(),
      );
      context.header("Cache-Control", "private, no-store");
      return context.json(result);
    });
  }

  routes.get("/api/chat-agents/:agentId/authority", async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.authority) return errorResponse(context, "unavailable");
    const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
    if (!agentId.success) return errorResponse(context, "invalid_request");
    const view = await options.authority.view(principal.userId, agentId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json(view);
  });

  // DELETE is a mutation: bounded like the others, although it ignores any body.
  routes.delete("/api/chat-agents/:agentId/grants/:grantId", limit, async (context) => {
    const principal = options.getPrincipal(context);
    if (!options.grants) return errorResponse(context, "unavailable");
    const agentId = ChatAgentIdSchema.safeParse(context.req.param("agentId"));
    const grantId = BotGrantIdSchema.safeParse(context.req.param("grantId"));
    if (!agentId.success || !grantId.success) return errorResponse(context, "invalid_request");
    const result = await options.grants.revoke(principal.userId, agentId.data, grantId.data);
    context.header("Cache-Control", "private, no-store");
    return context.json(result);
  });

  return routes;
}
