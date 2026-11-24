import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createHmac, randomUUID } from "node:crypto";
import { sql, type KyselyPlugin, type PluginTransformQueryArgs, type PluginTransformResultArgs, type QueryResult, type RootOperationNode, type UnknownRow } from "kysely";
import type { KyselyPGlite } from "kysely-pglite";
import { createAppDb, type AppDbWithKysely } from "../../packages/gateway/src/app-db.js";
import { createAppRegistry, type AppRegistry } from "../../packages/gateway/src/app-db-registry.js";
import { SitePublicDataRepository, type SitePublicDataResult } from "../../packages/gateway/src/sites/public-data-repository.js";
import { createSitePublicDataRoutes } from "../../packages/gateway/src/sites/public-data-routes.js";
import { createTestPGlite } from "../helpers/pglite-test-helper.js";

const SECRET = "runtime-bound-token";
const siteId = randomUUID();
const capability = (request: unknown) => ({ siteId, appSlug: "tasks-lab", versionId: randomUUID(), visitor: "a".repeat(64), request });

/** Records the largest result the gateway process receives from Postgres. */
function resultMeter(): KyselyPlugin & { largest: number } {
  const meter = {
    largest: 0,
    transformQuery: (args: PluginTransformQueryArgs): RootOperationNode => args.node,
    transformResult: async (args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> => {
      meter.largest = Math.max(meter.largest, Buffer.byteLength(JSON.stringify(args.result.rows)));
      return args.result;
    },
  };
  return meter;
}

function signed(body: unknown) {
  const raw = JSON.stringify(body);
  const stamp = String(Date.now());
  return new Request(`http://gateway/api/internal/sites/${siteId}/data`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-matrix-site-timestamp": stamp, "x-matrix-site-signature": createHmac("sha256", SECRET).update(`${stamp}.${raw}`).digest("hex") },
    body: raw,
  });
}

describe("public data reads stay bounded in gateway memory", () => {
  const BUDGET = 4_000;
  let instance: InstanceType<typeof KyselyPGlite>;
  let created: AppDbWithKysely;
  let registry: AppRegistry;

  beforeEach(async () => {
    instance = await createTestPGlite();
    created = createAppDb({ dialect: instance.dialect });
    await created.db.bootstrap();
    registry = createAppRegistry(created.db, created.kysely);
    await registry.register({ slug: "tasks-lab", name: "Tasks", tables: { tasks: { columns: { title: "text" } } } });
    await SitePublicDataRepository.bootstrap(created.kysely);
  });
  afterEach(async () => { await created.db.destroy(); });

  function repository(meter: KyselyPlugin) {
    return new SitePublicDataRepository(created.kysely.withPlugin(meter), { resolveApp: (slug) => registry.get(slug), maxResponseBytes: BUDGET });
  }

  it("refuses a page larger than the response budget without loading its rows", async () => {
    for (let i = 0; i < 20; i++) await sql`INSERT INTO "tasks-lab".tasks (title) VALUES (${"x".repeat(500)})`.execute(created.kysely);
    const meter = resultMeter();
    await expect(repository(meter).execute(capability({ kind: "db", action: { action: "find", table: "tasks" } }))).rejects.toMatchObject({ code: "unavailable" });
    expect(meter.largest).toBeLessThan(BUDGET);
  });

  it("still serves a page that fits the budget", async () => {
    await sql`INSERT INTO "tasks-lab".tasks (title) VALUES ('Plan')`.execute(created.kysely);
    const result: SitePublicDataResult = await repository(resultMeter()).execute(capability({ kind: "db", action: { action: "find", table: "tasks" } }));
    expect(result.result).toEqual([expect.objectContaining({ title: "Plan" })]);
  });

  it("refuses an oversized row and key value without loading them", async () => {
    await sql`INSERT INTO "tasks-lab".tasks (title) VALUES (${"y".repeat(BUDGET * 2)})`.execute(created.kysely);
    const id = (await sql<{ id: string }>`SELECT id FROM "tasks-lab".tasks LIMIT 1`.execute(created.kysely)).rows[0]!.id;
    await sql`INSERT INTO public._kv (app, key, value, updated_at) VALUES ('tasks-lab', 'big', ${"z".repeat(BUDGET * 2)}, now())`.execute(created.kysely);
    const meter = resultMeter();
    const repo = repository(meter);
    await expect(repo.execute(capability({ kind: "db", action: { action: "findOne", table: "tasks", id } }))).rejects.toMatchObject({ code: "unavailable" });
    await expect(repo.execute(capability({ kind: "kvRead", key: "big" }))).rejects.toMatchObject({ code: "unavailable" });
    expect(meter.largest).toBeLessThan(BUDGET);
  });
});

describe("public data admission at the gateway", () => {
  it("caps concurrent visitor requests so they cannot crowd out the owner", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const repository = { execute: async () => { await held; return { result: [], changed: null }; } } as unknown as SitePublicDataRepository;
    const app = new Hono();
    app.route("/", createSitePublicDataRoutes({ serviceSecret: SECRET, repository, env: {}, maxInFlight: 2 }));
    const request = () => app.request(signed(capability({ kind: "kvRead", key: "k" })));
    const first = [request(), request()];
    const over = await request();
    expect(over.status).toBe(429);
    release();
    expect((await Promise.all(first)).map((response) => response.status)).toEqual([200, 200]);
    expect((await request()).status).toBe(200);
  });
});
