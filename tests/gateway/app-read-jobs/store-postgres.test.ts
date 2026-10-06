import { randomUUID } from "node:crypto";
import pg from "pg";
import { Kysely, PostgresDialect, sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppReadJobRunner } from "../../../packages/gateway/src/app-read-jobs/runner.js";
import { createAppReadJobStore } from "../../../packages/gateway/src/app-read-jobs/store.js";
import { READ_JOB_TABLES, ReadJobConfigSchema } from "../../../packages/gateway/src/app-read-jobs/types.js";
import { createAppDb } from "../../../packages/gateway/src/app-db.js";
const url = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!url)("app read jobs across independent PostgreSQL clients", () => {
  let dbs: Kysely<any>[], stores: ReturnType<typeof createAppReadJobStore>[], app: string;
  let job: ReturnType<typeof ReadJobConfigSchema.parse>["jobs"][number];
  beforeEach(async () => {
    app = "readjobs_" + randomUUID().replaceAll("-", "");
    dbs = [0, 1].map(() => new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 2 }) }) }));
    const appDb = createAppDb({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }) });
    await appDb.db.createAppSchema(app);
    for (const [name, def] of Object.entries(READ_JOB_TABLES)) await appDb.db.createTable(app, name, def.columns, def.indexes, def.uniqueIndexes);
    await appDb.db.destroy();
    job = ReadJobConfigSchema.parse({ jobs: [{ id: "brief", app, enabled: true, recipe: "developer-briefing-v1", intervalMs: 900000, sources: [{ id: "repo", service: "github", connectionId: "account", label: "Work", params: { repo: "owner/repo" } }] }] }).jobs[0]!;
    stores = dbs.map(db => createAppReadJobStore({ db, ownerId: "owner", registeredApp: async () => ({ slug: app, tables: READ_JOB_TABLES }) }));
    await Promise.all(stores.map(s => s.prepare(job)));
  });
  afterEach(async () => { if (dbs?.[0]) await sql`DROP SCHEMA IF EXISTS ${sql.id(app)} CASCADE`.execute(dbs[0]); await Promise.all((dbs ?? []).map(d => d.destroy())); });
  it("claims one winner, persists restart state, and prevents stale completion after lease takeover", async () => {
    const claims = await Promise.all(stores.map(s => s.claim(job, true)));
    const winner = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    await sql`UPDATE ${sql.id(app, "read_job_state")} SET lease_until=now()-interval '1 second'`.execute(dbs[0]!);
    const next = await stores[1]!.claim(job, true);
    expect(next!.generation).toBe(winner.generation + 1);
    expect(await stores[0]!.finish(job, winner, { snapshots: [], status: "completed" })).toBe(false);
    expect(await stores[1]!.finish(job, next!, { snapshots: [], status: "completed" })).toBe(true);
    const restarted = createAppReadJobStore({ db: dbs[0]!, ownerId: "owner", registeredApp: async () => ({ slug: app, tables: READ_JOB_TABLES }) });
    expect(await restarted.claim(job, false)).toBeNull();
    expect(await restarted.status(job)).toMatchObject({ status: "completed", generation: next!.generation });
  });
  it("pause fences an in-flight collection and retains the last successful snapshot", async () => {
    const first = (await stores[0]!.claim(job, true))!;
    const snapshot = { sourceKey: "repo", service: "github", scope: { repo: "owner/repo" }, coverage: "complete", observedAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), records: [] } as const;
    expect(await stores[0]!.finish(job, first, { snapshots: [snapshot as any], status: "completed" })).toBe(true);
    const pending = (await stores[1]!.claim(job, true))!;
    await stores[0]!.setPaused(job, true);
    expect(await stores[1]!.finish(job, pending, { snapshots: [], status: "completed" })).toBe(false);
    expect(await stores[1]!.claim(job, true)).toBeNull();
    expect(await stores[0]!.snapshots(job)).toHaveLength(1);
    await stores[0]!.setPaused(job, false);
    expect(await stores[1]!.claim(job, true)).not.toBeNull();
    expect((await sql`SELECT 1`.execute(dbs[0]!)).rows).toHaveLength(1);
  });
  it("collects without a renderer, persists snapshots, and restart honors the durable due time", async () => {
    const requests: unknown[] = [];
    const dependencies={ownerId:"owner",loadConfig:async()=>({jobs:[job]}),authorize:async()=>{},read:async(input:unknown)=>{requests.push(input);return {data:[]};}};
    const first=createAppReadJobRunner({...dependencies,store:stores[0]!});
    first.start();await first.idle();await first.stop();
    expect(requests).toHaveLength(1);
    expect(await stores[1]!.status(job)).toMatchObject({status:"completed"});
    expect((await stores[1]!.snapshots(job))[0]?.records).toEqual([{action:"list_prs",params:{repo:"owner/repo",state:"all",page:1,per_page:30},data:[]}]);
    const restarted=createAppReadJobRunner({...dependencies,store:stores[1]!});
    restarted.start();await restarted.idle();await restarted.stop();
    expect(requests).toHaveLength(1);
  });
  it("rolls back state and receipt changes when snapshot persistence fails",async()=>{
    const claim=(await stores[0]!.claim(job,true))!;
    await expect(stores[0]!.finish(job,claim,{status:"completed",snapshots:[{sourceKey:"repo",service:"github",scope:{repo:"owner/repo"},coverage:"complete",records:[],observedAt:"bad timestamp",lastSuccessAt:null}]})).rejects.toThrow();
    expect(await stores[1]!.status(job)).toMatchObject({status:"running",generation:claim.generation,lastSuccessAt:null});
    expect(await stores[0]!.snapshots(job)).toEqual([]);
    expect(await stores[1]!.finish(job,claim,{status:"completed",snapshots:[]})).toBe(true);
  });

  it("persists a fenced AI attempt before inference and survives aborted completion or restart",async()=>{
    const claim=(await stores[0]!.claim(job,true))!;
    expect(await stores[0]!.markSummaryAttempt(job,claim)).toBe(true);
    const attempted=(await stores[1]!.status(job))?.summaryAttemptAt;
    expect(attempted).toEqual(expect.any(String));
    await stores[0]!.finish(job,claim,{status:"aborted",snapshots:[]});
    expect((await stores[1]!.status(job))?.summaryAttemptAt).toBe(attempted);
    const next=(await stores[1]!.claim(job,true))!;
    expect(await stores[0]!.markSummaryAttempt(job,claim)).toBe(false);
    await stores[0]!.setPaused(job,true);
    expect(await stores[1]!.markSummaryAttempt(job,next)).toBe(false);
    expect((await stores[1]!.status(job))?.summaryAttemptAt).toBe(attempted);
  });

  it("persists unsuccessful AI attempts without inventing successful summaries",async()=>{
    const claim=(await stores[0]!.claim(job,true))!;
    expect(await stores[0]!.finish(job,claim,{status:"completed",snapshots:[],summary:{status:"unavailable"}})).toBe(true);
    const state=await stores[1]!.status(job);
    expect(state?.summaryAttemptAt).toEqual(expect.any(String));
    expect(state?.summaryAt).toBeNull();
    expect(state?.summaryHash).toBeNull();
    const next=(await stores[0]!.claim(job,true))!;
    await stores[0]!.finish(job,next,{status:"completed",snapshots:[],summary:{status:"not_due"}});
    expect((await stores[1]!.status(job))?.summaryAttemptAt).toBe(state?.summaryAttemptAt);
  });
  it("disabling a changed job aborts its durable running receipt even with no future claim",async()=>{
    const claim=(await stores[0]!.claim(job,true))!;
    const disabled={...job,enabled:false};
    await stores[1]!.prepare(disabled);
    expect(await stores[0]!.status(disabled)).toMatchObject({status:"idle",leaseUntil:null,generation:claim.generation+1});
    const receipts=await sql<{status:string}>`SELECT status FROM ${sql.id(app,"read_job_runs")} WHERE generation=${claim.generation}`.execute(dbs[0]!);
    expect(receipts.rows).toEqual([{status:"aborted"}]);
    expect(await stores[0]!.finish(job,claim,{status:"completed",snapshots:[]})).toBe(false);
    expect(await stores[1]!.claim(disabled,false)).toBeNull();
  });

});
