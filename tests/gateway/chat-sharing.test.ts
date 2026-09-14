import { afterEach, beforeEach, expect, it } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository";
import { ChatSharing, bootstrapChatSharing } from "../../packages/gateway/src/chat/sharing";

let repository: ChatRepository;
let shares: ChatSharing;
const owner = { type: "personal" as const, ownerId: "user_owner" };
beforeEach(async () => {
  const pg = await KyselyPGlite.create();
  repository = new ChatRepository(pg.dialect);
  await repository.bootstrap();
  await bootstrapChatSharing(repository.kysely);
  await repository.create(owner, { id: "chat_share", clientRequestId: "req_create", title: "Example <script>" });
  await repository.kysely.insertInto("chat_messages").values({
    id: "message_share", chat_id: "chat_share", seq: 1, role: "user", state: "committed",
    turn_id: null, run_id: null, parts: JSON.stringify([{ type: "text", text: "Hello <script>" }, { type: "tool_result", text: "secret" }]),
    byte_count: 20, search_text: "Hello", created_at: new Date(),
  }).execute();
  shares = new ChatSharing(repository.kysely);
});
afterEach(async () => repository.kysely.destroy());

it("creates a bounded text snapshot, keeps it immutable, and revokes access", async () => {
  const result = await shares.create(owner, "chat_share", 0);
  const snapshot = await shares.read(result.token);
  expect(snapshot?.messages).toEqual([{ role: "user", text: "Hello <script>" }]);
  await repository.kysely.updateTable("chat_messages").set({ parts: JSON.stringify([{ type: "text", text: "Later" }]) }).execute();
  expect((await shares.read(result.token))?.messages[0]?.text).toBe("Hello <script>");
  await shares.revoke(owner, "chat_share", result.id);
  expect(await shares.read(result.token)).toBeNull();
});

it("rejects another owner and stale revision without minting a token", async () => {
  await expect(shares.create({ type: "personal", ownerId: "other" }, "chat_share", 1)).rejects.toThrow();
  await expect(shares.create(owner, "chat_share", 999)).rejects.toThrow();
  expect(await shares.list(owner, "chat_share")).toEqual([]);
});

it("expires shares and removes them when the source Chat is deleted", async () => {
  const first = await shares.create(owner, "chat_share", 0);
  await repository.kysely.updateTable("chat_shares").set({ expires_at: new Date(0) }).execute();
  expect(await shares.read(first.token)).toBeNull();
  const second = await shares.create(owner, "chat_share", 0);
  await repository.kysely.deleteFrom("chats").where("id", "=", "chat_share").execute();
  expect(await shares.read(second.token)).toBeNull();
});

it("requires the confirmed preview fingerprint even if the Chat revision is unchanged", async () => {
  const preview = await shares.preview(owner, "chat_share");
  await repository.kysely.updateTable("chat_messages").set({ parts: JSON.stringify([{ type: "text", text: "Changed after preview" }]) }).execute();
  await expect(shares.create(owner, "chat_share", preview.revision, preview.fingerprint)).rejects.toThrow();
  expect(await shares.list(owner, "chat_share")).toEqual([]);
});

it("wires owner preview, listing, creation, public read, and revocation", async () => {
  const { Hono } = await import("hono");
  const { markAuthContextReady, setPlatformVerifiedPrincipal } = await import("../../packages/gateway/src/request-principal");
  const { createChatSharingRoutes } = await import("../../packages/gateway/src/chat/sharing-routes");
  const app = new Hono();
  app.use("/api/*", async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, owner.ownerId); await next(); });
  app.route("/", createChatSharingRoutes(shares));
  const path = "/api/chats/chat_share/shares";
  expect(await (await app.request(path)).json()).toEqual({ shares: [] });
  const preview = await (await app.request(path + "/preview")).json();
  const createdResponse = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmed: true, revision: preview.revision, fingerprint: preview.fingerprint }) });
  expect(createdResponse.status).toBe(201);
  const created = await createdResponse.json();
  expect((await (await app.request(path)).json()).shares).toHaveLength(1);
  expect((await app.request("/api/share/chats/" + created.token)).status).toBe(200);
  expect((await app.request(path + "/" + created.id, { method: "DELETE" })).status).toBe(200);
  expect((await app.request("/api/share/chats/" + created.token)).status).toBe(404);
});

it("normalizes PostgreSQL bigint revisions for preview and confirmed creation", async () => {
  const postgresLike = repository.kysely.withPlugin({
    transformQuery: ({ node }) => node,
    async transformResult({ result }) {
      return { ...result, rows: result.rows.map((row) => "revision" in row ? { ...row, revision: String(row.revision) } : row) };
    },
  });
  const service = new ChatSharing(postgresLike);
  const preview = await service.preview(owner, "chat_share");
  expect(preview.revision).toBe(0);
  const created = await service.create(owner, "chat_share", 0, preview.fingerprint);
  expect(await service.read(created.token)).not.toBeNull();
});
