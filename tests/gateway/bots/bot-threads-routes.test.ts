import { CanonicalChatListResponseSchema, CanonicalChatRecordSchema } from "@matrix-os/contracts";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrainApiError } from "../../../packages/gateway/src/brain/api/types.js";
import { createBotThreads } from "../../../packages/gateway/src/bots/bot-threads.js";
import { createBotBrainProjects, type BotBrainProjects } from "../../../packages/gateway/src/bots/brain-projects.js";
import { createCustomBotChats } from "../../../packages/gateway/src/bots/custom-direct-chat.js";
import type { OwnerBotDatabase } from "../../../packages/gateway/src/bots/database.js";
import { createBotRecipeCatalog } from "../../../packages/gateway/src/bots/recipe-catalog.js";
import { createBotRoutes } from "../../../packages/gateway/src/bots/routes.js";
import { MATRIX_BOT_SELECTION } from "../../../packages/gateway/src/bots/selection.js";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { BOT, NOW, OTHER_OWNER, OWNER, createBotStateDatabase, createRealBotStateDatabase } from "./bot-state-support.js";

const PROJECT = "proj_brain01";
const SECOND = "proj_brain02";
const WRITER = "bot_fedcba9876543210";
const ARCHIVED = "bot_0000000000aaaaaa";
const agent = (id: string, recipeId: string, version: string, archived = false) => ({
  id, name: "Company Brain", description: "", instructions: "Short answers.", archived, selection: MATRIX_BOT_SELECTION,
  recipeRef: { recipeId, version }, revision: 1, createdAt: NOW, updatedAt: NOW,
});
const AGENTS: Record<string, ReturnType<typeof agent>> = {
  [BOT]: agent(BOT, "company-brain", "2026-10-08.1"),
  [WRITER]: agent(WRITER, "writing-bot", "2026-09-27.1"),
  [ARCHIVED]: agent(ARCHIVED, "company-brain", "2026-10-08.1", true),
};

let db: Kysely<OwnerBotDatabase>;
let destroy: (() => Promise<void>) | undefined;
afterEach(async () => { await destroy?.(); destroy = undefined; });

/** The agent store owns this lock table; these tests use a fake store. */
async function ownerLocks() {
  await sql`CREATE TABLE IF NOT EXISTS chat_agent_owner_locks (owner_key TEXT PRIMARY KEY)`.execute(db);
}

function app(projects: Partial<BotBrainProjects> = {}) {
  const repository = new ChatRepository(db as unknown as Kysely<ChatDatabase>);
  const agents = { get: vi.fn(async (owner: { ownerId: string }, id: string) => (owner.ownerId === OWNER ? AGENTS[id] ?? null : null) as never) };
  const threads = createBotThreads({
    chats: repository, agents, recipes: createBotRecipeCatalog(),
    projects: {
      resolve: vi.fn(async (_ownerId: string, ref: string) => ([PROJECT, SECOND].includes(ref)
        ? { projectId: ref, slug: ref.replace("proj_", ""), name: "Brain" } : null)),
      ...projects,
    },
  });
  const routes = new Hono().route("/", createBotRoutes({
    threads, botChats: createCustomBotChats({ chats: repository, agents }),
    getPrincipal: (context) => ({ userId: context.req.header("x-owner") ?? OWNER, source: "jwt" }),
  }));
  const post = (body: unknown, agentId = BOT, headers: Record<string, string> = {}) => routes.request(`/api/chat-agents/${agentId}/threads`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const list = (query: string, agentId = BOT) => routes.request(`/api/chat-agents/${agentId}/threads?${query}`);
  return { routes, post, list, repository };
}

describe("bot thread routes", () => {
  beforeEach(async () => { ({ db, destroy } = await createBotStateDatabase()); await ownerLocks(); });

  it("creates a Bot chat for one project, replays it, and lists it like /api/chats", async () => {
    const { routes, post, list } = app();
    const created = await post({ clientRequestId: "req_thread1", projectId: PROJECT, title: "Bot chat sidebar" });
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    const record = CanonicalChatRecordSchema.parse(await created.json());
    expect(record.chat).toMatchObject({ title: "Bot chat sidebar", currentSelection: MATRIX_BOT_SELECTION, lifecycle: "active" });
    expect(record.projectId).toBeUndefined();
    const replay = await post({ clientRequestId: "req_thread1", projectId: PROJECT, title: "Bot chat sidebar" });
    expect(replay.status).toBe(200);
    expect(CanonicalChatRecordSchema.parse(await replay.json()).chat.id).toBe(record.chat.id);
    expect((await post({ clientRequestId: "req_thread1", projectId: SECOND })).status).toBe(409);
    expect(await (await routes.request(`/api/chats/${record.chat.id}/bot`)).json()).toEqual({ agentId: BOT });
    const page = CanonicalChatListResponseSchema.parse(await (await list(`projectId=${PROJECT}`)).json());
    expect(page.items.map((item) => item.chat.id)).toEqual([record.chat.id]);
    expect(CanonicalChatListResponseSchema.parse(await (await list(`projectId=${SECOND}`)).json()).items).toEqual([]);
    const bindings = await db.selectFrom("bot_chat_bindings").select(["kind", "project_id"]).where("chat_id", "=", record.chat.id).execute();
    expect(bindings).toEqual([{ kind: "thread", project_id: PROJECT }]);
  });

  it("refuses bad requests, foreign or unknown projects and Bots without threads", async () => {
    const { post, list } = app();
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ clientRequestId: "req_x", projectId: PROJECT, extra: true })).status).toBe(400);
    expect((await post({ clientRequestId: "req_x", projectId: "matrix-os" })).status).toBe(400);
    expect((await post({ clientRequestId: "req_x", projectId: "proj_foreign" })).status).toBe(400);
    expect((await post({ clientRequestId: "req_x", projectId: PROJECT }, "not-a-bot")).status).toBe(400);
    expect((await post({ clientRequestId: "req_x", projectId: PROJECT }, WRITER)).status).toBe(404);
    expect((await post({ clientRequestId: "req_x", projectId: PROJECT }, ARCHIVED)).status).toBe(404);
    expect((await post({ clientRequestId: "req_x", projectId: PROJECT }, BOT, { "x-owner": OTHER_OWNER })).status).toBe(404);
    expect((await post({ clientRequestId: "req_x", projectId: "x".repeat(70 * 1024) })).status).toBe(413);
    expect((await list(`projectId=${PROJECT}`, WRITER)).status).toBe(404);
    expect((await list("limit=5")).status).toBe(400);
    expect((await list(`projectId=${PROJECT}&projectId=${SECOND}`)).status).toBe(400);
    expect((await list(`projectId=${PROJECT}&cursor=chatcur_bad`)).status).toBe(400);
    expect(await db.selectFrom("chats").select("id").execute()).toEqual([]);
    const outage = app({ resolve: vi.fn(async () => { throw new Error("project lookup down"); }) });
    const down = await outage.post({ clientRequestId: "req_x", projectId: PROJECT });
    expect(down.status).toBe(503);
    expect(JSON.stringify(await down.json())).not.toContain("project lookup down");
  });

  it("never adopts another Chat that holds the request and stops at 1,000 live threads", async () => {
    const { post, repository } = app();
    await repository.create({ type: "personal", ownerId: OWNER }, { id: "chat_ordinary1", clientRequestId: "req_taken", title: "Mine" });
    expect((await post({ clientRequestId: "req_taken", projectId: PROJECT })).status).toBe(409);
    expect(await db.selectFrom("bot_chat_bindings").selectAll().execute()).toEqual([]);
    await sql`INSERT INTO chats (id, owner_type, owner_id, create_request_id, title, lifecycle, attention)
      SELECT 'chat_seed' || i, 'personal', ${OWNER}, 'req_seed' || i, 'Seed', 'active', 'none' FROM generate_series(1, 1000) i`.execute(db);
    await sql`INSERT INTO bot_chat_bindings (owner_id, bot_id, chat_id, kind, project_id, created_at)
      SELECT ${OWNER}, ${BOT}, 'chat_seed' || i, 'thread', ${PROJECT}, now() FROM generate_series(1, 1000) i`.execute(db);
    expect((await post({ clientRequestId: "req_over", projectId: PROJECT })).status).toBe(429);
    await db.deleteFrom("chats").where("id", "=", "chat_seed1").execute();
    expect((await post({ clientRequestId: "req_over", projectId: PROJECT })).status).toBe(201);
  });

  it("pages threads by newest activity", async () => {
    const { post, list } = app();
    const ids: string[] = [];
    for (const index of [1, 2, 3]) {
      const record = CanonicalChatRecordSchema.parse(await (await post({ clientRequestId: `req_page${index}`, projectId: PROJECT })).json());
      await db.updateTable("chats").set({ activity_at: new Date(Date.parse(NOW) + index * 1_000).toISOString() }).where("id", "=", record.chat.id).execute();
      ids.push(record.chat.id);
    }
    const first = CanonicalChatListResponseSchema.parse(await (await list(`projectId=${PROJECT}&limit=2`)).json());
    expect(first.items.map((item) => item.chat.id)).toEqual([ids[2], ids[1]]);
    const second = CanonicalChatListResponseSchema.parse(await (await list(`projectId=${PROJECT}&limit=2&cursor=${first.nextCursor}`)).json());
    expect(second).toEqual({ items: [expect.objectContaining({ chat: expect.objectContaining({ id: ids[0] }) })] });
  });
});

describe("bot thread list query", () => {
  it("is checked at the route, so the service only ever sees a typed query", async () => {
    const list = vi.fn(async () => ({ items: [] }));
    const routes = new Hono().route("/", createBotRoutes({
      threads: { create: vi.fn(), list }, getPrincipal: () => ({ userId: OWNER, source: "jwt" }),
    }));
    const get = (query: string) => routes.request(`/api/chat-agents/${BOT}/threads?${query}`);
    for (const query of [
      "limit=5", `projectId=${PROJECT}&projectId=${SECOND}`, `projectId=${PROJECT}&limit=5&limit=6`, `projectId=${PROJECT}&limit=0`,
      `projectId=${PROJECT}&limit=101`, `projectId=${PROJECT}&cursor=bad`, `projectId=${PROJECT}&other=1`, "projectId=matrix-os",
    ]) {
      expect((await get(query)).status).toBe(400);
    }
    expect((await routes.request(`/api/chat-agents/not-a-bot/threads?projectId=${PROJECT}`)).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
    expect((await get(`projectId=${PROJECT}`)).status).toBe(200);
    expect((await get(`projectId=${PROJECT}&limit=2&cursor=chatcur_abc`)).status).toBe(200);
    expect(list.mock.calls).toEqual([
      [OWNER, BOT, { projectId: PROJECT, limit: 50 }],
      [OWNER, BOT, { projectId: PROJECT, limit: 2, cursor: "chatcur_abc" }],
    ]);
  });
});

describe("brain project lookups for bots", () => {
  beforeEach(async () => { ({ db, destroy } = await createBotStateDatabase()); });

  it("resolves the owner's project, reads missing ones as null, keeps outages loud and bounds the list", async () => {
    const resolve = vi.fn(async (_ownerId: string, ref: string) => {
      if (ref === "missing") throw new BrainApiError("project_not_found");
      if (ref === "down") throw new BrainApiError("brain_unavailable");
      return { projectId: PROJECT, slug: "matrix-os", name: "Matrix OS", scope: {} as never };
    });
    const listManagedProjects = vi.fn(async () => ({ projects: Array.from({ length: 30 }, (_, index) => ({ slug: `p${index}` })) }));
    const projects = createBotBrainProjects({ resolver: { resolve }, projects: { listManagedProjects } });
    await expect(projects.resolve(OWNER, PROJECT)).resolves.toEqual({ projectId: PROJECT, slug: "matrix-os", name: "Matrix OS" });
    await expect(projects.resolve(OWNER, "missing")).resolves.toBeNull();
    await expect(projects.resolve(OWNER, "down")).rejects.toEqual(new BrainApiError("brain_unavailable"));
    await expect(projects.slugs(OWNER, 20)).resolves.toHaveLength(20);
    expect(listManagedProjects).toHaveBeenCalledWith({ ownerScope: { type: "user", id: OWNER } });
  });
});

describe.skipIf(!process.env.MATRIX_TEST_POSTGRES_URL)("bot thread creation on pooled Postgres", () => {
  beforeEach(async () => { ({ db, destroy } = await createRealBotStateDatabase()); await ownerLocks(); });

  it("creates one Chat and one binding for concurrent retries of the same request", async () => {
    const { post } = app();
    const responses = await Promise.all(Array.from({ length: 8 }, () => post({ clientRequestId: "req_race", projectId: PROJECT })));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    const ids = new Set(await Promise.all(responses.map(async (response) => CanonicalChatRecordSchema.parse(await response.json()).chat.id)));
    expect(ids.size).toBe(1);
    expect(await db.selectFrom("bot_chat_bindings").select("kind").execute()).toEqual([{ kind: "thread" }]);
  });
});
