import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { CodexChatImporter } from "../../packages/gateway/src/chat/codex-importer.js";
import { createCodexChatImportRoutes } from "../../packages/gateway/src/chat/codex-import-routes.js";
import { MissingRequestPrincipalError } from "../../packages/gateway/src/request-principal.js";

const sourceId = "019eb0ae-9a30-7541-bdb8-db4d17e65146";
const post = (app: Hono, path: string, body: unknown) => app.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

describe("Codex Chat import routes", () => {
  let pg: InstanceType<typeof KyselyPGlite>;
  let chats: ChatRepository;
  let app: Hono;

  beforeEach(async () => {
    pg = await KyselyPGlite.create();
    chats = new ChatRepository(pg.dialect);
    await chats.bootstrap();
    app = new Hono().route("/", createCodexChatImportRoutes({
      importer: new CodexChatImporter(chats),
      getPrincipal: () => ({ userId: "ash_test", source: "jwt" }),
    }));
  });
  afterEach(async () => { await chats.kysely.destroy(); });

  it("authenticates an import and publishes it through bounded requests", async () => {
    const begin = await post(app, "/api/chats/imports/codex", {
      sourceId, sourceHash: "a".repeat(64), title: "Imported session",
    });
    expect(begin.status).toBe(201);
    expect(await begin.json()).toMatchObject({ status: "uploading", nextSeq: 1 });
    const batch = await post(app, `/api/chats/imports/codex/${sourceId}/messages`, {
      startSeq: 1, messages: [{ role: "user", text: "Hello", createdAt: "2026-09-03T16:01:00.000Z" }],
    });
    expect(batch.status).toBe(200);
    expect(await batch.json()).toMatchObject({ nextSeq: 2 });
    const complete = await post(app, `/api/chats/imports/codex/${sourceId}/complete`, { messageCount: 1 });
    expect(complete.status).toBe(200);
    const result = await complete.json() as { chatId: string };
    expect((await chats.get({ type: "personal", ownerId: "ash_test" }, result.chatId))?.chat.messageCount).toBe(1);
  });

  it("rejects a missing principal before creating owner staging rows", async () => {
    const denied = new Hono().route("/", createCodexChatImportRoutes({
      importer: new CodexChatImporter(chats),
      getPrincipal: () => { throw new MissingRequestPrincipalError(); },
    }));
    const response = await post(denied, "/api/chats/imports/codex", {
      sourceId, sourceHash: "a".repeat(64), title: "Imported session",
    });
    expect(response.status).toBe(401);
    const jobs = await chats.kysely.selectFrom("chat_import_jobs").select("source_id").execute();
    expect(jobs).toEqual([]);
  });

  it("reports an unavailable backend as a service error", async () => {
    const unavailable = new Hono().route("/", createCodexChatImportRoutes({
      importer: null, getPrincipal: () => ({ userId: "ash_test", source: "jwt" }),
    }));
    const response = await post(unavailable, "/api/chats/imports/codex", {
      sourceId, sourceHash: "a".repeat(64), title: "Imported session",
    });
    expect(response.status).toBe(503);
  });

  it("validates source path IDs before calling the importer", async () => {
    const importer = new CodexChatImporter(chats);
    const append = vi.spyOn(importer, "append");
    const complete = vi.spyOn(importer, "complete");
    const routes = new Hono().route("/", createCodexChatImportRoutes({
      importer, getPrincipal: () => ({ userId: "ash_test", source: "jwt" }),
    }));
    expect((await post(routes, "/api/chats/imports/codex/bad/messages", {})).status).toBe(400);
    expect((await post(routes, "/api/chats/imports/codex/bad/complete", {})).status).toBe(400);
    expect(append).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
