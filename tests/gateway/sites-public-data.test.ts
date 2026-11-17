import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHmac, randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { KyselyPGlite } from "kysely-pglite";
import { createAppDb, type AppDbWithKysely } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry, type AppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { SitePublicDataRepository } from "../../packages/gateway/src/sites/public-data-repository.js";
import { createSitePublicDataLimiter, createSitePublicDataRoutes } from "../../packages/gateway/src/sites/public-data-routes.js";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerSiteRuntime } from "../../packages/gateway/src/sites/wiring.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const SECRET = "runtime-bound-token";
const siteId = randomUUID();
const versionId = randomUUID();
const visitor = "a".repeat(64);

function signed(body: unknown, id = siteId, secret = SECRET) {
  const raw = JSON.stringify(body);
  const stamp = String(Date.now());
  return new Request(`http://gateway/api/internal/sites/${id}/data`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-matrix-site-timestamp": stamp, "x-matrix-site-signature": createHmac("sha256", secret).update(`${stamp}.${raw}`).digest("hex") },
    body: raw,
  });
}
const capability = (request: unknown, appSlug = "tasks-lab") => ({ siteId, appSlug, versionId, visitor, request });
const db = (action: unknown, appSlug?: string) => capability({ kind: "db", action }, appSlug);

describe("public site visitor data at the owner gateway", () => {
  let instance: InstanceType<typeof KyselyPGlite>;
  let created: AppDbWithKysely;
  let registry: AppRegistry;
  let repository: SitePublicDataRepository;
  let app: Hono;
  let changes: Array<{ app: string; key: string }>;
  const env: NodeJS.ProcessEnv = {};

  beforeEach(async () => {
    instance = await createTestPGlite();
    created = createAppDb({ dialect: instance.dialect });
    await created.db.bootstrap();
    registry = createAppRegistry(created.db, created.kysely);
    await registry.register({ slug: "tasks-lab", name: "Tasks", tables: { tasks: { columns: { title: "text", done: "boolean", payload: "jsonb" } } } });
    await registry.register({ slug: "private-notes", name: "Notes", tables: { notes: { columns: { body: "text" } } } });
    await SitePublicDataRepository.bootstrap(created.kysely);
    repository = new SitePublicDataRepository(created.kysely, { resolveApp: (slug) => registry.get(slug), retention: { maxEntriesPerSite: 3, maxAgeDays: 30 } });
    changes = [];
    delete env.MATRIX_SITES_PUBLIC_DATA;
    app = new Hono();
    app.route("/", createSitePublicDataRoutes({ serviceSecret: SECRET, repository, env, onChange: (change) => changes.push(change) }));
  });
  afterEach(async () => { await created.db.destroy(); });

  async function call(body: unknown) {
    const response = await app.request(signed(body));
    return { status: response.status, body: await response.json() as any };
  }
  async function log() {
    return (await sql<any>`SELECT site_id, app_slug, table_name, row_id, op, before, after, visitor_hash FROM public._site_visitor_writes ORDER BY id`.execute(created.kysely)).rows;
  }

  it("lets a visitor read, create, update and delete the published app's rows like the owner bridge", async () => {
    const inserted = await call(db({ action: "insert", table: "tasks", data: { title: "Plan", done: false } }));
    expect(inserted.status).toBe(200);
    const id = inserted.body.result.id;
    expect(typeof id).toBe("string");
    expect((await call(db({ action: "find", table: "tasks", filter: { done: false } }))).body.result).toEqual([expect.objectContaining({ id, title: "Plan", done: false })]);
    expect((await call(db({ action: "update", table: "tasks", id, data: { done: true } }))).body.result).toEqual({ ok: true });
    expect((await call(db({ action: "findOne", table: "tasks", id }))).body.result).toEqual(expect.objectContaining({ id, done: true }));
    expect((await call(db({ action: "count", table: "tasks" }))).body.result).toEqual({ count: 1 });
    expect((await call(db({ action: "delete", table: "tasks", id }))).body.result).toEqual({ ok: true });
    expect((await call(db({ action: "findOne", table: "tasks", id }))).body.result).toBeNull();
    expect(changes).toEqual([{ app: "tasks-lab", key: "tasks" }, { app: "tasks-lab", key: "tasks" }, { app: "tasks-lab", key: "tasks" }]);
  });

  it("records each visitor write with before/after and a visitor hash in the same transaction", async () => {
    const { body } = await call(db({ action: "insert", table: "tasks", data: { title: "Plan", done: false } }));
    await call(db({ action: "update", table: "tasks", id: body.result.id, data: { title: "Ship" } }));
    await call(db({ action: "delete", table: "tasks", id: body.result.id }));
    await call(capability({ kind: "kvWrite", key: "theme", value: "dark" }));
    // The per-site cap (3 here) trims the oldest entry inside the write transaction.
    expect((await log()).map((entry) => [entry.op, entry.table_name, entry.visitor_hash])).toEqual([
      ["update", "tasks", visitor], ["delete", "tasks", visitor], ["kv_write", "_kv", visitor],
    ]);
  });

  it("logs before and after snapshots and keys entries by row id", async () => {
    const { body } = await call(db({ action: "insert", table: "tasks", data: { title: "Plan", done: false } }));
    const id = body.result.id;
    await call(db({ action: "update", table: "tasks", id, data: { title: "Ship" } }));
    await call(db({ action: "delete", table: "tasks", id }));
    const [insert, update, remove] = await log();
    expect(insert).toMatchObject({ site_id: siteId, app_slug: "tasks-lab", row_id: id, before: null, after: expect.objectContaining({ title: "Plan" }) });
    expect(update).toMatchObject({ row_id: id, before: expect.objectContaining({ title: "Plan" }), after: expect.objectContaining({ title: "Ship" }) });
    expect(remove).toMatchObject({ row_id: id, before: expect.objectContaining({ title: "Ship" }), after: null });
    expect(JSON.stringify(await log())).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  it("rolls the visitor write back when the write log cannot be written", async () => {
    await sql`ALTER TABLE public._site_visitor_writes ADD CONSTRAINT reject_all CHECK (false) NOT VALID`.execute(created.kysely);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await call(db({ action: "insert", table: "tasks", data: { title: "Plan" } }));
    expect(result.status).toBe(400);
    expect((await sql<any>`SELECT count(*)::int AS count FROM "tasks-lab".tasks`.execute(created.kysely)).rows[0].count).toBe(0);
    expect(changes).toEqual([]);
    warn.mockRestore();
  });

  it("keeps visitors inside the published app and its tables", async () => {
    await created.db.raw(`INSERT INTO "private-notes".notes (body) VALUES ('secret')`);
    expect((await call(db({ action: "find", table: "notes" }))).status).toBe(400);
    expect((await call(db({ action: "find", table: "_apps" }))).status).toBe(400);
    expect((await call(db({ action: "listApps" }))).status).toBe(400);
    expect((await call({ ...db({ action: "find", table: "tasks" }), request: { kind: "db", action: { action: "find", table: "tasks", app: "private-notes" } } })).status).toBe(400);
    expect((await call(db({ action: "find", table: "notes" }, "missing-app"))).status).toBe(503);
    await created.db.raw(`INSERT INTO public._kv (app, key, value) VALUES ('private-notes', 'theme', 'owner-only')`);
    expect((await call(capability({ kind: "kvRead", key: "theme" }))).body.result).toEqual({ value: null });
    await call(capability({ kind: "kvWrite", key: "theme", value: "dark" }));
    expect((await call(capability({ kind: "kvRead", key: "theme" }))).body.result).toEqual({ value: "dark" });
    expect((await created.db.raw(`SELECT value FROM public._kv WHERE app = 'private-notes'`)).rows).toEqual([{ value: "owner-only" }]);
  });

  it("supports bulk and compare-and-swap writes with per-row log entries", async () => {
    const inserted = await call(db({ action: "bulkInsert", table: "tasks", rows: [{ title: "A" }, { title: "B" }] }));
    expect(inserted.body.result.ids).toHaveLength(2);
    const [a, b] = inserted.body.result.ids;
    await call(db({ action: "bulkUpdate", table: "tasks", updates: [{ id: a, data: { done: true } }, { id: b, data: { done: true } }] }));
    await created.db.raw(`UPDATE "tasks-lab".tasks SET payload = '{"v":1}'::jsonb WHERE id = $1`, [a]);
    expect((await call(db({ action: "compareAndSwap", table: "tasks", id: a, expectedPayload: { v: 2 }, data: { title: "X" } }))).body.result).toEqual({ ok: false });
    expect((await call(db({ action: "compareAndSwap", table: "tasks", id: a, expectedPayload: { v: 1 }, data: { title: "X" } }))).body.result).toEqual({ ok: true });
    // Five row entries (2 inserts, 2 updates, 1 swap); the failed swap logged nothing; cap keeps the newest 3.
    expect((await log()).map((entry) => entry.op)).toEqual(["update", "update", "update"]);
  });

  it("returns appInfo and the app's own schema without exposing other apps", async () => {
    expect((await call(db({ action: "schema" }))).body.result).toEqual({ tasks: expect.any(Object) });
    expect((await call(db({ action: "appInfo" }))).body.result).toEqual({ installedVersion: "1.0.0" });
  });

  it("maps payload faults to Invalid change and never echoes database text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const unknownColumn = await call(db({ action: "insert", table: "tasks", data: { nope: "x" } }));
    expect(unknownColumn).toEqual({ status: 400, body: { error: "Invalid change" } });
    const badId = await call(db({ action: "findOne", table: "tasks", id: "not-a-uuid" }));
    expect(badId).toEqual({ status: 400, body: { error: "Invalid change" } });
    warn.mockRestore();
  });

  it("rejects unsigned, mismatched, malformed and kill-switched requests", async () => {
    const body = db({ action: "find", table: "tasks" });
    expect((await app.request(signed(body, siteId, "wrong-secret"))).status).toBe(401);
    expect((await app.request(signed(body, randomUUID()))).status).toBe(400);
    expect((await app.request(signed({ ...body, visitor: "1.2.3.4" }))).status).toBe(400);
    expect((await app.request(signed(db({ action: "find", table: "tasks", limit: 501 })))).status).toBe(400);
    env.MATRIX_SITES_PUBLIC_DATA = "off";
    const off = await app.request(signed(body));
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: "Shared data is unavailable" });
  });

  it("is mounted by the site runtime with the owner database, registry and change broadcast", async () => {
    const runtime = new Hono();
    const broadcast = vi.fn();
    await registerSiteRuntime(runtime, { homePath: "/unused", db: created.kysely, env: { MATRIX_SYNC_RUNTIME_TOKEN: SECRET },
      publicData: { resolveApp: (slug) => registry.get(slug), onChange: broadcast } });
    const response = await runtime.request(signed(db({ action: "insert", table: "tasks", data: { title: "Wired" } })));
    expect(response.status).toBe(200);
    expect(broadcast).toHaveBeenCalledWith({ app: "tasks-lab", key: "tasks" });
  });

  it("returns 503 when the owner database is not configured", async () => {
    const unconfigured = new Hono();
    unconfigured.route("/", createSitePublicDataRoutes({ serviceSecret: SECRET, repository: null, env: {} }));
    expect((await unconfigured.request(signed(db({ action: "find", table: "tasks" })))).status).toBe(503);
  });
});

describe("public data admission", () => {
  it("rate-limits per site and evicts the oldest site at the cap", () => {
    const limiter = createSitePublicDataLimiter(2, 3);
    expect([limiter.check("a", 0), limiter.check("a", 0), limiter.check("a", 0)]).toEqual([true, true, false]);
    expect(limiter.check("a", 60_001)).toBe(true);
    for (const key of ["b", "c", "d", "e"]) limiter.check(key, 0);
    expect(limiter.size).toBe(3);
  });

  it("exempts only the exact signed data path from bearer auth", async () => {
    const app = new Hono();
    app.use("*", authMiddleware("bearer-secret"));
    app.post("/api/internal/sites/:siteId/data", (c) => c.json({ ok: true }));
    app.get("/api/internal/sites/:siteId/data", (c) => c.json({ ok: true }));
    app.post("/api/internal/sites/:siteId/data-export", (c) => c.json({ ok: true }));
    const headers = { "x-matrix-site-signature": "fake", "x-matrix-site-timestamp": String(Date.now()) };
    expect((await app.request(`/api/internal/sites/${siteId}/data`, { method: "POST", headers })).status).toBe(200);
    expect((await app.request(`/api/internal/sites/${siteId}/data`, { headers })).status).toBe(401);
    expect((await app.request(`/api/internal/sites/${siteId}/data-export`, { method: "POST", headers })).status).toBe(401);
    expect((await app.request(`/api/internal/sites/${siteId}/data`, { method: "POST" })).status).toBe(401);
  });
});
