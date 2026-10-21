import { randomUUID } from "node:crypto";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GallerySyncRepository } from "../../packages/gateway/src/app-gallery/sync-repository.js";

const postgresUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const postgres = postgresUrl ? describe : describe.skip;
postgres("Gallery settings and PostgreSQL worker admission", () => {
  const schema = `gallery_sync_test_${randomUUID().replaceAll("-", "")}`;
  const application = `${schema}_configure`;
  let admin: pg.Pool, worker: Kysely<any>, configuring: Kysely<any>;
  let repository: GallerySyncRepository;
  const now = new Date("2026-10-19T00:00:00Z");
  const selection = { requestId: randomUUID(), accounts: [{ service: "gmail", label: "Work", connectionId: "work", expectedEmail: null }],
    start: "2026-10-01", end: "2026-10-19", context: "", scope: "work" as const, keepUpdated: true };
  function database(name: string) {
    const url = new URL(postgresUrl!);
    if (!url.pathname.toLowerCase().includes("test")) throw new Error("A test database is required");
    return new Kysely<any>({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url.toString(), max: 1,
      application_name: name, options: `-c search_path=${schema},public -c statement_timeout=5000 -c lock_timeout=4000` }) }) });
  }
  beforeAll(async () => {
    // Validate before creating a schema in an explicitly named test database.
    if (!new URL(postgresUrl!).pathname.toLowerCase().includes("test")) throw new Error("A test database is required");
    admin = new pg.Pool({ connectionString: postgresUrl, max: 1, statement_timeout: 5000 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    worker = database(`${schema}_worker`); configuring = database(application);
    repository = new GallerySyncRepository(worker); await repository.bootstrap();
  });
  afterAll(async () => {
    await Promise.all([worker?.destroy(), configuring?.destroy()]);
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await admin.end(); }
  });
  it.each(["running", "queued"])("does not replace a concurrently admitted %s run with new account settings", async status => {
    await worker.deleteFrom("gallery_sync").execute();
    await repository.configure("owner", "people", { ...selection, requestId: randomUUID() }, now);
    const lease = (await repository.claim(now))!;
    await repository.finish(lease, { status: "complete" }, now);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const runId = randomUUID();
    const admission = worker.transaction().execute(async trx => {
      const row = await trx.selectFrom("gallery_sync").selectAll().where("app_id", "=", "people").forUpdate().executeTakeFirstOrThrow();
      await trx.updateTable("gallery_sync").set({ run_id: runId, snapshot: JSON.stringify({ ...row.snapshot, runId, status }), lease_until: new Date(now.getTime() + 600_000) }).execute();
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    const next = new GallerySyncRepository(configuring).configure("owner", "people", { ...selection, requestId: randomUUID() }, now)
      .then(value => ({ value, rejected: false }), () => ({ rejected: true }));
    try {
      const deadline = Date.now() + 2000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const result = await admin.query("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting", [application]);
        waiting = result.rows[0]?.waiting === true;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
    } finally { release.resolve(); }
    await admission;
    expect(await next).toMatchObject({ rejected: true });
    expect((await repository.get("owner", "people"))?.snapshot).toMatchObject({ runId, status });
  });
});
