import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { bootstrapChatDatabase } from "../../packages/gateway/src/chat/database";
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

it("removes private assistant paths and credentials from public share previews and snapshots", async () => {
  await repository.kysely.insertInto("chat_messages").values({
    id: "assistant_share", chat_id: "chat_share", seq: 2, role: "assistant", state: "committed",
    turn_id: null, run_id: null,
    parts: JSON.stringify([{ type: "text", text: "Open /home/ma" },
      { type: "text", text: "trix/home/private/report.txt. ACCESS_TO" },
      { type: "text", text: "KEN=qa-fake-2058" }]),
    byte_count: 48, search_text: "Open", created_at: new Date(),
  }).execute();
  const preview = await shares.preview(owner, "chat_share");
  expect(preview.messages[1]?.text).toBe("Open [redacted path] [redacted credential]");
  const created = await shares.create(owner, "chat_share", preview.revision, preview.fingerprint);
  expect((await shares.read(created.token))?.messages[1]?.text).toBe("Open [redacted path] [redacted credential]");
});

it("projects old immutable snapshots when reading a public link", async () => {
  const created = await shares.create(owner, "chat_share", 0);
  await repository.kysely.updateTable("chat_shares").set({ snapshot: JSON.stringify({
    title: "Fixture", messages: [{ role: "assistant", text: "Open /home/matrix/home/private/report.txt ACCESS_TOKEN=qa-fake-2058" }],
  }) }).where("id", "=", created.id).execute();
  expect((await shares.read(created.token))?.messages[0]?.text)
    .toBe("Open [redacted path] [redacted credential]");
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

async function addDriveReference() {
  await repository.kysely.updateTable("chat_messages").set({ parts: JSON.stringify([
    { type: "text", text: "Private drive discussion" },
    { type: "resource_reference", resource: { kind: "organization_drive" } },
  ]) }).where("id", "=", "message_share").execute();
}

it("blocks drive-backed preview and minting without exposing another owner's existence", async () => {
  await addDriveReference();
  await expect(shares.preview(owner, "chat_share")).rejects.toMatchObject({ code: "conflict" });
  await expect(shares.create(owner, "chat_share", 0)).rejects.toMatchObject({ code: "conflict" });
  await expect(shares.preview({ type: "personal", ownerId: "other" }, "chat_share")).rejects.toMatchObject({ code: "not_found" });
  await expect(shares.create({ type: "personal", ownerId: "other" }, "chat_share", 0)).rejects.toMatchObject({ code: "not_found" });
  expect(await shares.list(owner, "chat_share")).toEqual([]);
});

it("blocks previously minted public links after drive context is added but permits owner revocation", async () => {
  const created = await shares.create(owner, "chat_share", 0);
  await addDriveReference();
  expect(await shares.read(created.token)).toBeNull();
  expect(await shares.list(owner, "chat_share")).toHaveLength(1);
  await shares.revoke(owner, "chat_share", created.id);
  expect(await shares.list(owner, "chat_share")).toEqual([]);
});

it("blocks sharing when drive context exists only in a run snapshot", async () => {
  const now = new Date();
  await repository.kysely.transaction().execute(async (trx) => {
    await trx.insertInto("chat_turns").values({
      id: "turn_drive", chat_id: "chat_share", client_request_id: "request_drive",
      base_message_seq: 1, input_message_id: "message_share", status: "failed", created_at: now, updated_at: now,
    }).execute();
    await trx.insertInto("chat_runs").values({
      id: "run_drive", chat_id: "chat_share", turn_id: "turn_drive", client_request_id: "request_drive",
      attempt: 1, driver_kind: "claude", instance_id: "default", selection: "{}",
      interaction_mode: "chat", permission_mode: "default", status: "failed", history_boundary_seq: 1,
      capability_snapshot: "{}", context_snapshot: JSON.stringify({ drives: [{}] }), created_at: now, updated_at: now,
    }).execute();
  });
  await expect(shares.preview(owner, "chat_share")).rejects.toMatchObject({ code: "conflict" });
  await expect(shares.create(owner, "chat_share", 0)).rejects.toMatchObject({ code: "conflict" });
  expect(await shares.list(owner, "chat_share")).toEqual([]);
});

it("wires drive privacy to legacy preview, token creation, and public read routes", async () => {
  const { Hono } = await import("hono");
  const { markAuthContextReady, setPlatformVerifiedPrincipal } = await import("../../packages/gateway/src/request-principal");
  const { createChatSharingRoutes } = await import("../../packages/gateway/src/chat/sharing-routes");
  const app = new Hono();
  app.use("/api/*", async (c, next) => { markAuthContextReady(c); setPlatformVerifiedPrincipal(c, owner.ownerId); await next(); });
  app.route("/", createChatSharingRoutes(shares));
  const preview = await shares.preview(owner, "chat_share");
  const created = await shares.create(owner, "chat_share", 0);
  await addDriveReference();
  const path = "/api/chats/chat_share/shares";
  expect((await app.request(path + "/preview")).status).toBe(409);
  expect((await app.request(path, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmed: true, revision: preview.revision, fingerprint: preview.fingerprint }) })).status).toBe(409);
  expect((await app.request("/api/share/chats/" + created.token)).status).toBe(404);
  expect((await (await app.request(path)).json()).shares).toHaveLength(1);
  expect((await app.request(path + "/" + created.id, { method: "DELETE" })).status).toBe(200);
});


it.each(["parts", "context_snapshot"] as const)("blocks queued-only drive %s before claim, including existing public tokens", async (field) => {
  const created = await shares.create(owner, "chat_share", 0);
  const now = new Date();
  await repository.kysely.insertInto("chat_queued_turns").values({
    id: "queue_drive", chat_id: "chat_share", client_request_id: "req_queue", position: 1, status: "queued",
    parts: JSON.stringify(field === "parts" ? [{ type: "resource_reference", resource: { kind: "organization_drive" } }] : [{ type: "text", text: "Queued" }]),
    context_snapshot: field === "context_snapshot" ? JSON.stringify({ drives: [{}] }) : null,
    driver_kind: "claude", instance_id: "default", selection: "{}", interaction_mode: "chat",
    permission_mode: "default", capability_snapshot: "{}", created_at: now, updated_at: now,
  }).execute();
  await expect(shares.preview(owner, "chat_share")).rejects.toMatchObject({ code: "conflict" });
  await expect(shares.create(owner, "chat_share", 0)).rejects.toMatchObject({ code: "conflict" });
  expect(await shares.read(created.token)).toBeNull();
  // Cancelled source records retain provenance; cancellation must not reopen public access.
  await repository.kysely.updateTable("chat_queued_turns").set({ status: "cancelled" }).where("id", "=", "queue_drive").execute();
  expect(await shares.read(created.token)).toBeNull();
});

it("bootstraps usable partial indexes for each drive-material lookup", async () => {
  await repository.bootstrap();
  await repository.kysely.transaction().execute(async (trx) => {
    await sql`SET LOCAL enable_seqscan = off`.execute(trx);
    const predicates = [
      ["chat_messages", "idx_chat_messages_company_drive", sql`parts @> '[{"type":"resource_reference","resource":{"kind":"organization_drive"}}]'::jsonb`],
      ["chat_runs", "idx_chat_runs_company_drive", sql`context_snapshot ? 'drives'`],
      ["chat_queued_turns", "idx_chat_queued_turns_company_drive", sql`context_snapshot ? 'drives' OR parts @> '[{"type":"resource_reference","resource":{"kind":"organization_drive"}}]'::jsonb`],
    ] as const;
    for (const [table, index, predicate] of predicates) {
      const result = await sql<{ "QUERY PLAN": string }>`EXPLAIN SELECT 1 FROM ${sql.table(table)} WHERE chat_id = ${"chat_share"} AND (${predicate})`.execute(trx);
      expect(result.rows.map(row => row["QUERY PLAN"]).join("\n")).toContain(index);
    }
  });
});


it.each(["55P03", "57014", "08006"])("keeps owner bootstrap available only for optional index deadlines (%s)", async (code) => {
  await repository.kysely.transaction().execute(async trx => {
    await sql`DROP INDEX idx_chat_messages_company_drive`.execute(trx);
    await sql`DROP INDEX idx_chat_runs_company_drive`.execute(trx);
    await sql`DROP INDEX idx_chat_queued_turns_company_drive`.execute(trx);
  });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const fault = Object.assign(new Error("Synthetic database failure"), { code });
    const failing = repository.kysely.withPlugin({
      transformQuery: ({ node }) => {
        if (node.kind === "RawNode" && node.sqlFragments.join("").includes("CREATE INDEX IF NOT EXISTS idx_chat_runs_company_drive")) throw fault;
        return node;
      },
      async transformResult({ result }) { return result; },
    });
    if (code === "08006") await expect(bootstrapChatDatabase(failing)).rejects.toBe(fault);
    else {
      await expect(bootstrapChatDatabase(failing)).resolves.toBeUndefined();
      expect(warning).toHaveBeenCalledWith("[chat/drive-sharing] Optional indexes deferred after database deadline", code);
      expect(await repository.get(owner, "chat_share")).not.toBeNull();
      await addDriveReference();
      await expect(shares.preview(owner, "chat_share")).rejects.toMatchObject({ code: "conflict" });
    }
    const indexes = await sql`SELECT indexname FROM pg_indexes WHERE indexname IN
      ('idx_chat_messages_company_drive','idx_chat_runs_company_drive','idx_chat_queued_turns_company_drive')`.execute(repository.kysely);
    expect(indexes.rows).toEqual([]);
    // Retry on a subsequent bootstrap installs all indexes without losing owner data.
    await repository.bootstrap();
    const retried = await sql`SELECT indexname FROM pg_indexes WHERE indexname IN
      ('idx_chat_messages_company_drive','idx_chat_runs_company_drive','idx_chat_queued_turns_company_drive')`.execute(repository.kysely);
    expect(retried.rows).toHaveLength(3);
    expect(await repository.get(owner, "chat_share")).not.toBeNull();
  } finally { warning.mockRestore(); }
});

it("blocks sharing copied personal Memory sources even after queued cancellation", async () => {
  await repository.kysely.insertInto("chat_messages").values({
    id:"msg_memory", chat_id:"chat_share", seq:20, role:"user", state:"committed", purpose:"ai_request", turn_id:null,run_id:null,actor_id:null,
    parts:JSON.stringify([{type:"resource_reference",resource:{kind:"memory_source",id:"source",label:"private"}}]),byte_count:100,search_text:"",created_at:new Date(),
  }).execute();
  await expect(shares.preview(owner,"chat_share")).rejects.toMatchObject({code:"conflict"});
});
