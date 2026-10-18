import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { createDefaultOsViewDocument, OsViewDocumentSchema, PatchOsViewStateRequestSchema, mergeOsViewStatePatch } from "../../contracts/src/os-view.js";
import { createWorkspaceAuthenticator, type WorkspaceAuthOptions } from "./auth.js";
import { readSharedFileSnapshot, WorkspaceError, type WorkspaceRepository, type SharedChat } from "./data/repository.js";
import { MAX_TEXT_BYTES, type WorkspaceFiles } from "./data/files.js";

export type WorkspaceAction = { type: "wake" } | { type: "chat"; chatId: string; message: string; idempotencyKey: string };
export interface WorkspaceRuntimeAdapter {
  status(ownerId: string): Promise<unknown>;
  enqueue(ownerId: string, action: WorkspaceAction): Promise<unknown>;
}
export interface WorkspaceRouteOptions {
  repository: WorkspaceRepository; files: WorkspaceFiles; runtime: WorkspaceRuntimeAdapter;
  auth: WorkspaceAuthOptions; previewEnabled: boolean;
}
const relativePath = z.string().min(1).max(512).refine((value) =>
  !value.startsWith("/") && !/[\\\u0000-\u001f]/.test(value) && value.split("/").every((part) => part !== ".." && part !== "." && part.length > 0));
const limitSchema = z.coerce.number().int().min(1).max(100).default(50);
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const chatIdSchema = z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/);
const requestIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("wake") }).strict(),
  z.object({ type: z.literal("chat"), chatId: chatIdSchema, message: z.string().trim().min(1).max(16_000), idempotencyKey: requestIdSchema }).strict(),
]);
const layoutSchema = z.object({ windows: z.array(z.record(z.string().max(100), z.json())).max(100), baseRevision: revision }).strict();
const textBodySchema = z.object({ path: relativePath, content: z.string().max(MAX_TEXT_BYTES), baseRevision: revision }).strict();
function canonicalRecord(chat: SharedChat) {
  return { chat: {
    id: chat.id, ownerScope: { type: "personal", ownerId: chat.ownerId }, title: chat.title,
    lifecycle: "active", attention: "none", revision: 0, messageCount: 0,
    createdAt: chat.createdAt, updatedAt: chat.createdAt,
  } };
}

export function createWorkspaceRoutes(options: WorkspaceRouteOptions) {
  const app = new Hono<{ Variables: { ownerId: string } }>();
  const authenticate = createWorkspaceAuthenticator(options.auth);
  app.use("*", async (c, next) => {
    if (!options.previewEnabled) return c.json({ error: "Not found" }, 404);
    const ownerId = await authenticate(c.req.raw);
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    c.set("ownerId", ownerId);
    c.header("Cache-Control", "private, no-store");
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof WorkspaceError) return c.json({ error: error.code }, error.code === "conflict" ? 409 : error.code === "not_found" ? 404 : 400);
    if (error instanceof SyntaxError) return c.json({ error: "Invalid request" }, 400);
    console.error("[workspace-api] request failed", error instanceof Error ? error.name : "UnknownError");
    return c.json({ error: "Workspace service unavailable" }, 503);
  });
  const bounded = bodyLimit({ maxSize: MAX_TEXT_BYTES + 2048, onError: (c) => c.json({ error: "Request too large" }, 413) });
  // The desktop's data connection is available even when execution is asleep.
  app.get("/health", async (c) => {
    await options.repository.bootstrap(c.get("ownerId"));
    return c.json({ status: "ok" });
  });
  app.get("/api/shell/bootstrap", async (c) => c.json(await options.repository.bootstrap(c.get("ownerId"))));
  app.get("/api/apps", async (c) => c.json((await options.repository.bootstrap(c.get("ownerId"))).apps));
  app.get("/api/layout", async (c) => {
    const bootstrap = await options.repository.bootstrap(c.get("ownerId"));
    return c.json({ ...bootstrap.layout, revision: bootstrap.revision });
  });
  app.put("/api/layout", bounded, async (c) => {
    const parsed = layoutSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: "Invalid layout" }, 400);
    return c.json({ ok: true, ...await options.repository.saveLayout(c.get("ownerId"), { windows: parsed.data.windows }, parsed.data.baseRevision) });
  });
  app.get("/api/settings/:setting", async (c) => {
    const setting = z.enum(["theme", "desktop", "onboarding-status"]).safeParse(c.req.param("setting"));
    if (!setting.success) return c.json({ error: "Not found" }, 404);
    const settings = await options.repository.settings(c.get("ownerId"));
    if (setting.data === "onboarding-status") return c.json({ complete: settings.onboardingComplete === true });
    return c.json(settings[setting.data] ?? {});
  });
  app.put("/api/settings/:setting", bounded, async (c) => {
    const setting = z.enum(["theme", "desktop"]).safeParse(c.req.param("setting"));
    const value = z.record(z.string().max(100), z.json()).safeParse(await c.req.json());
    if (!setting.success || !value.success) return c.json({ error: "Invalid settings" }, 400);
    const owner = c.get("ownerId");
    const current = await options.repository.bootstrap(owner);
    return c.json({ ok: true, ...await options.repository.saveSetting(owner, setting.data, value.data, current.revision) });
  });
  app.get("/api/os-view-state", async (c) => {
    const owner = c.get("ownerId");
    const { settings, revision: stateRevision } = await options.repository.settingsSnapshot(owner);
    const stored = settings.osView as { document?: unknown; updatedAt?: unknown } | undefined;
    const saved = OsViewDocumentSchema.safeParse(stored?.document ?? settings.osView);
    return c.json({ revision: stateRevision + 1, document: saved.success ? saved.data : createDefaultOsViewDocument(), updatedAt: typeof stored?.updatedAt === "string" ? stored.updatedAt : new Date(0).toISOString() });
  });
  app.patch("/api/os-view-state", bounded, async (c) => {
    const input = PatchOsViewStateRequestSchema.safeParse(await c.req.json());
    if (!input.success) return c.json({ error: "Invalid OS view" }, 400);
    const owner = c.get("ownerId");
    const { settings, revision: stateRevision } = await options.repository.settingsSnapshot(owner);
    const stored = settings.osView as { document?: unknown; mutationId?: string; updatedAt?: string } | undefined;
    const parsed = OsViewDocumentSchema.safeParse(stored?.document);
    if (stored?.mutationId === input.data.mutationId) return c.json({ revision: stateRevision + 1, document: parsed.success ? parsed.data : createDefaultOsViewDocument(), updatedAt: stored.updatedAt });
    if (input.data.baseRevision !== stateRevision + 1) return c.json({ error: "conflict" }, 409);
    const document = mergeOsViewStatePatch(parsed.success ? parsed.data : createDefaultOsViewDocument(), input.data.patch);
    const updatedAt = new Date().toISOString();
    const result = await options.repository.saveSetting(owner, "osView", { document, mutationId: input.data.mutationId, updatedAt }, stateRevision);
    return c.json({ revision: result.revision + 1, document, updatedAt });
  });
  const listFiles = async (owner: string, path: string, limit: number) => options.repository.listFiles(owner, path ? `${path}/` : "", limit);
  for (const route of ["/api/files", "/api/files/list", "/api/files/tree"]) {
    app.get(route, async (c) => {
      const input = z.object({ path: relativePath.or(z.literal("")).default(""), limit: limitSchema }).safeParse({ path: c.req.query("path"), limit: c.req.query("limit") });
      if (!input.success) return c.json({ error: "Invalid query" }, 400);
      const files = await listFiles(c.get("ownerId"), input.data.path, input.data.limit);
      // Gateway directory contract; immediate children only, with synthesized directories.
      const prefix = input.data.path ? `${input.data.path}/` : "";
      const entries = files.map((file) => {
        const relative = file.path.slice(prefix.length); const name = relative.split("/")[0];
        return { name, type: relative.includes("/") ? "directory" : "file", size: file.bytes, gitStatus: null, modified: file.updatedAt };
      }).filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index);
      return c.json(route === "/api/files/tree" ? entries : { path: input.data.path, entries });
    });
  }
  for (const route of ["/api/files/text", "/api/files/blob"]) {
    app.get(route, async (c) => {
      const path = relativePath.safeParse(c.req.query("path"));
      if (!path.success) return c.json({ error: "Invalid path" }, 400);
      let file = await options.repository.file(c.get("ownerId"), path.data);
      if (!file) return c.json({ error: "Not found" }, 404);
      const snapshot = await readSharedFileSnapshot(options.repository, key => options.files.read(key), c.get("ownerId"), file);
      file = snapshot.file;
      const { content } = snapshot;
      return route.endsWith("blob") ? c.text(content) : c.json({ path: file.path, content, revision: file.revision });
    });
  }
  app.put("/api/files/text", bounded, async (c) => {
    const input = textBodySchema.safeParse(await c.req.json());
    if (!input.success || new TextEncoder().encode(input.data?.content ?? "").byteLength > MAX_TEXT_BYTES) return c.json({ error: "Invalid file" }, 400);
    const owner = c.get("ownerId"); const { path, content, baseRevision } = input.data;
    const previous = await options.repository.file(owner, path);
    const key = await options.files.write(owner, content);
    try {
      const file = await options.repository.commitFile(owner, path, key, new TextEncoder().encode(content).byteLength, baseRevision);
      if (previous && previous.objectKey !== key) {
        try { await options.files.remove(previous.objectKey); } catch (cleanupError) { console.error("[workspace-files] superseded cleanup failed", cleanupError instanceof Error ? cleanupError.name : "UnknownError"); }
      }
      return c.json({ ok: true, path: file.path, revision: file.revision });
    } catch (error) {
      try { await options.files.remove(key); } catch (cleanupError) { console.error("[workspace-files] orphan cleanup failed", cleanupError instanceof Error ? cleanupError.name : "UnknownError"); }
      throw error;
    }
  });
  app.get("/api/chats", async (c) => {
    const query = z.object({ limit: limitSchema, scope: z.enum(["global", "all"]).optional(), cursor: z.string().max(200).optional(), unread: z.enum(["true", "false"]).optional() }).safeParse(c.req.query());
    if (!query.success || query.data.cursor) return c.json({ error: "Invalid query" }, 400);
    return c.json({ items: (await options.repository.listChats(c.get("ownerId"), query.data.limit)).map(canonicalRecord) });
  });
  app.post("/api/chats", bounded, async (c) => {
    const input = z.object({ clientRequestId: requestIdSchema, title: z.string().trim().min(1).max(200).default("New chat") }).strict().safeParse(await c.req.json());
    if (!input.success) return c.json({ error: "Invalid chat" }, 400);
    return c.json(canonicalRecord(await options.repository.createChat(c.get("ownerId"), input.data.clientRequestId, input.data.title)), 201);
  });
  app.get("/api/chats/:chatId", async (c) => {
    const id = chatIdSchema.safeParse(c.req.param("chatId"));
    if (!id.success) return c.json({ error: "Invalid chat" }, 400);
    const chat = await options.repository.chat(c.get("ownerId"), id.data);
    if (!chat) return c.json({ error: "Not found" }, 404);
    const messages = await options.repository.messages(c.get("ownerId"), id.data);
    const record = canonicalRecord(chat); record.chat.messageCount = messages.length;
    return c.json({ record, messages: messages.map((message) => ({ id: message.id, chatId: message.chatId, seq: message.seq, role: message.role, state: "committed", parts: [{ type: "text", text: message.text }], createdAt: message.createdAt })), turns: [], runs: [], activities: [] });
  });
  app.get("/api/workspace/runtime", async (c) => c.json(await options.runtime.status(c.get("ownerId"))));
  app.post("/api/workspace/actions", bounded, async (c) => {
    const input = actionSchema.safeParse(await c.req.json());
    if (!input.success) return c.json({ error: "Invalid action" }, 400);
    const owner = c.get("ownerId");
    if (input.data.type === "chat") {
      const action = input.data;
      const chat = await options.repository.chat(owner, action.chatId)
        ?? await options.repository.createChat(owner, action.idempotencyKey, action.message.slice(0, 100));
      await options.repository.appendMessage(owner, chat.id, action.idempotencyKey, "user", action.message);
      return c.json({ ...await options.runtime.enqueue(owner, { ...action, chatId: chat.id }) as Record<string, unknown>, chatId: chat.id }, 202);
    }
    return c.json(await options.runtime.enqueue(owner, input.data), 202);
  });
  return app;
}
