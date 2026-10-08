import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BrainJobStore, bootstrapBrainJobsDatabase, createBrainJobWorker, type BrainJobStep,
} from "../../packages/gateway/src/brain/jobs/index.js";
import type { BrainDatabase, BrainScopeKey } from "../../packages/gateway/src/brain/types.js";

// Claims with FOR UPDATE SKIP LOCKED, the owner lock and the dedupe index across connections are only proven here.
// Only a disposable test server is appropriate: every test creates its own schema and drops it afterwards.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const scopes: BrainScopeKey[] = Array.from({ length: 6 }, (_, i) => ({ ownerId: "owner_pg", scopeId: `scope_${i}` }));

describe.skipIf(!databaseUrl)("brain jobs across independent PostgreSQL connections", () => {
  let admin: pg.Pool;
  let schema: string;
  let dbs: Kysely<BrainDatabase>[];
  let stores: BrainJobStore[];

  beforeEach(async () => {
    schema = `brain_jobs_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    dbs = [0, 1].map(() => new Kysely<BrainDatabase>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url.toString(), max: 4 }) }),
    }));
    await Promise.all(dbs.map((db) => bootstrapBrainJobsDatabase(db)));
    stores = dbs.map((db) => new BrainJobStore(db));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(dbs.map((db) => db.destroy()));
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  });

  it("dedupes concurrent enqueues and never hands one job to two claims", async () => {
    const both = await Promise.all(stores.map((store) => store.enqueue(scopes[0]!, "proj_0", { kind: "sync" })));
    expect(both.filter((result) => result.created)).toHaveLength(1);
    expect(both[0]!.job.jobId).toBe(both[1]!.job.jobId);
    for (const scope of scopes.slice(1)) await stores[0]!.enqueue(scope, "proj", { kind: "sync" });
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      stores[i % 2]!.claim("owner_pg", `w_${i}`, 60_000)));
    const taken = claims.flatMap((claim) => (claim === null ? [] : [claim.jobId]));
    expect(taken).toHaveLength(scopes.length);
    expect(new Set(taken).size).toBe(scopes.length);
  });

  it("runs every job exactly once with two workers", async () => {
    for (const scope of scopes) await stores[0]!.enqueue(scope, "proj", { kind: "graph_refresh" });
    const runs = new Map<string, number>();
    const step: BrainJobStep = async ({ scope, step: n }) => {
      runs.set(scope.scopeId, (runs.get(scope.scopeId) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { caughtUp: n === 2, stopCode: null, summary: { n } };
    };
    const workers = stores.map((store, i) => createBrainJobWorker({
      store, ownerId: "owner_pg", steps: { graph_refresh: step }, workerId: `w_${i}`,
      limits: { stepPauseMs: 0, pollMs: 20 },
    }));
    workers.forEach((worker) => worker.start());
    try {
      await vi.waitFor(async () => {
        const jobs = await Promise.all(scopes.map((scope) => stores[1]!.list(scope, 5)));
        expect(jobs.flat().map((job) => job.status)).toEqual(scopes.map(() => "succeeded"));
      }, { timeout: 10_000, interval: 20 });
    } finally {
      await Promise.all(workers.map((worker) => worker.stop()));
    }
    expect([...runs.values()]).toEqual(scopes.map(() => 2));
  });
});
