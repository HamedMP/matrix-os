import { isChatAgentDriver } from "@matrix-os/contracts";
import {
  ChatAgentIdSchema, ChatAgentSchema, ChatAgentListResponseSchema, ChatMentionSearchResponseSchema,
  ChatAgentRecipeCatalogSchema,
  ChatContextSnapshotSchema, CreateChatAgentRequestSchema, UpdateChatAgentRequestSchema,
  CanonicalChatIdSchema, CanonicalChatResourceReferenceSchema, type CanonicalChatModelSelection,
} from "@matrix-os/contracts";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { isRequestPrincipalError, mapRequestPrincipalError, type RequestPrincipal } from "../request-principal.js";
import { ChatAgentStoreError, type ChatAgentStore } from "./agent-store.js";
import { ChatAgentContextError, type ChatAgentContext } from "./agent-context.js";
import type { ChatAgentRecipeResolver } from "./agent-recipe.js";
import { bindJevInboxRecipe, JevRecipeBindingError, type GmailAccountRow } from "./jev-recipe-authority.js";
import { revokeHermesJevCapabilitiesForAgent } from "./hermes-integration-capability.js";
import type { ChatRepository } from "./repository.js";
import { validateChatProviderSelection, type ChatProviderCatalogService } from "./provider-catalog.js";

const SearchSchema = z.object({
  query: z.string().trim().max(200).default(""),
  chatId: CanonicalChatIdSchema.optional(),
}).strict();

export function createChatAgentRoutes(options: {
  agents?: ChatAgentStore;
  repository?: ChatRepository;
  context?: ChatAgentContext;
  recipes?: ChatAgentRecipeResolver;
  enabled(): boolean;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  getPrincipal(context: Context): RequestPrincipal;
  listGmailAccounts?: (ownerId: string) => Promise<readonly GmailAccountRow[]>;
}): Hono {
  const routes = new Hono();
  const limit = bodyLimit({ maxSize: 40 * 1024, onError: (c) => c.json({ error: "Request too large" }, 413) });
  const owner = (context: Context) => ({ type: "personal" as const, ownerId: options.getPrincipal(context).userId });
  routes.onError((error: unknown, context) => {
    if (isRequestPrincipalError(error)) {
      const mapped = mapRequestPrincipalError(error);
      if (mapped.log) console.warn("[chat-agents] Principal context unavailable:", error.name);
      return context.json(mapped.body, mapped.status);
    }
    if (error instanceof Error && error.name === "BodyLimitError") return context.json({ error: "Request too large" }, 413);
    if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: "Invalid request" }, 400);
    if (error instanceof ChatAgentStoreError && error.code === "agent_not_found"
      || error instanceof ChatAgentContextError && error.code === "context_unavailable") {
      return context.json({ error: "Agent or Chat not found" }, 404);
    }
    if (error instanceof ChatAgentStoreError && error.code === "agent_conflict") {
      return context.json({ error: "Agent changed. Refresh and try again." }, 409);
    }
    if (error instanceof JevRecipeBindingError) {
      return context.json({ error: error.code === "account_unavailable"
        ? "Selected Gmail account is unavailable. Refresh and try again."
        : "Agents are temporarily unavailable." }, error.code === "account_unavailable" ? 409 : 503);
    }
    console.warn("[chat-agents] Request failed:", error instanceof Error ? error.name : "UnknownError");
    return context.json({ error: "Agents are temporarily unavailable." }, 503);
  });
  function requireServices() {
    if (!options.agents || !options.repository || !options.context) throw new Error("Chat Agent services unavailable");
    return { agents: options.agents, repository: options.repository, context: options.context };
  }
  function requireRecipes() {
    if (!options.recipes) throw new Error("Chat Agent recipe services unavailable");
    return options.recipes;
  }
  async function validSelection(principal: RequestPrincipal, selection: CanonicalChatModelSelection): Promise<boolean> {
    const catalog = await options.catalog.getCatalog(principal);
    const checked = validateChatProviderSelection({ catalog, selection,
      requirements: { interactionMode: "default", permissionMode: "full_access" },
    });
    return checked.ok && isChatAgentDriver(checked.instance.driverKind);
  }
  routes.get("/api/chat-agents", async (c) => {
    const scope = owner(c);
    if (!options.enabled()) return c.json({ enabled: false, agents: [] });
    const { agents } = requireServices();
    return c.json(ChatAgentListResponseSchema.parse({ enabled: true, agents: await agents.list(scope) }));
  });
  routes.get("/api/chat-agents/recipe-catalog", async (c) => {
    owner(c);
    if (!options.enabled()) {
      return c.json(ChatAgentRecipeCatalogSchema.parse({ enabled: false, skills: [], services: [] }));
    }
    return c.json(ChatAgentRecipeCatalogSchema.parse(await requireRecipes().catalog()));
  });
  routes.post("/api/chat-agents", limit, async (c) => {
    const principal = options.getPrincipal(c);
    if (!options.enabled()) return c.json({ error: "Agents are disabled." }, 409);
    const { agents } = requireServices();
    const input = CreateChatAgentRequestSchema.parse(await c.req.json());
    const scope = { type: "personal" as const, ownerId: principal.userId };
    const existing = await agents.findCreated(scope, input);
    if (existing) return c.json(ChatAgentSchema.parse(existing), 201);
    if (!await validSelection(principal, input.selection)) return c.json({ error: "Choose an available Agent model." }, 400);
    let recipe;
    try {
      recipe = input.recipe ? await bindJevInboxRecipe({ ownerId: principal.userId, recipe: input.recipe,
        listGmailAccounts: options.listGmailAccounts }) : undefined;
    } catch (error: unknown) {
      // A concurrent identical create can commit while inventory is failing.
      const saved = await agents.findCreated(scope, input);
      if (saved) return c.json(ChatAgentSchema.parse(saved), 201);
      throw error;
    }
    return c.json(ChatAgentSchema.parse(await agents.create(scope, input, recipe)), 201);
  });
  routes.patch("/api/chat-agents/:agentId", limit, async (c) => {
    const principal = options.getPrincipal(c);
    const id = ChatAgentIdSchema.parse(c.req.param("agentId"));
    if (!options.enabled()) return c.json({ error: "Agents are disabled." }, 409);
    const { agents } = requireServices();
    const input = UpdateChatAgentRequestSchema.parse(await c.req.json());
    if (input.selection && !await validSelection(principal, input.selection)) return c.json({ error: "Choose an available Agent model." }, 400);
    const recipe = input.recipe ? await bindJevInboxRecipe({ ownerId: principal.userId, recipe: input.recipe,
      listGmailAccounts: options.listGmailAccounts }) : undefined;
    const updated = await agents.update({ type: "personal", ownerId: principal.userId }, id, input, recipe);
    revokeHermesJevCapabilitiesForAgent(principal.userId, id);
    return c.json(ChatAgentSchema.parse(updated));
  });
  routes.get("/api/chat-mentions", async (c) => {
    const scope = owner(c);
    const input = SearchSchema.parse(c.req.query());
    if (!options.enabled()) return c.json({ enabled: false, resources: [] });
    const { agents, repository } = requireServices();
    const roles = (await agents.list(scope)).filter((agent) =>
      `${agent.name} ${agent.description}`.toLowerCase().includes(input.query.toLowerCase())).slice(0, 20);
    let query = repository.kysely.selectFrom("chats").select(["id", "title"])
      .where("owner_type", "=", scope.type).where("owner_id", "=", scope.ownerId)
      .where("lifecycle", "=", "active").where("collaboration", "is", null);
    if (input.chatId) query = query.where("id", "!=", input.chatId);
    if (input.query) query = query.where("title", "ilike", `%${input.query.replace(/[\\%_]/g, "\\$&")}%`);
    const chats = await query.orderBy("updated_at", "desc").orderBy("id").limit(20).execute();
    return c.json(ChatMentionSearchResponseSchema.parse({ enabled: true, resources: [
      ...roles.map((agent) => ({ kind: "agent", id: agent.id, label: agent.name, revision: String(agent.revision) })),
      ...chats.map((chat) => {
        const label = CanonicalChatResourceReferenceSchema.shape.label.safeParse(chat.title);
        return { kind: "chat", id: chat.id, label: label.success ? label.data : "Chat" };
      }),
    ] }));
  });
  routes.get("/api/chat-context/:chatId", async (c) => {
    const scope = owner(c);
    const chatId = CanonicalChatIdSchema.parse(c.req.param("chatId"));
    if (!options.enabled()) return c.json({ error: "Chat references are disabled." }, 409);
    return c.json(ChatContextSnapshotSchema.parse(await requireServices().context.preview(scope, chatId)));
  });
  return routes;
}
