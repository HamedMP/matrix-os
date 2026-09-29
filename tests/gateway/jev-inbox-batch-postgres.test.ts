import { randomUUID } from "node:crypto";
import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevInboxBatchRepository, type BatchDocument } from "../../packages/gateway/src/jev/inbox-batch-store.js";
const url = process.env.MATRIX_TEST_POSTGRES_URL;
describe.skipIf(!url)("durable Inbox checkpoints across independent PostgreSQL clients", () => {
  let admin: pg.Pool, schema: string;
  let connections: Kysely<any>[];
  let stores: JevInboxBatchRepository[];
  beforeEach(async () => {
    admin = new pg.Pool({ connectionString: url, max: 1 });
    schema = "jev_batch_" + randomUUID().replaceAll("-", "");
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const u = new URL(url!);
    u.searchParams.set("options", `-c search_path=${schema}`);
    connections = [0, 1].map(() => new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: u.toString(), max: 2 }) }) }));
    stores = connections.map(db => new JevInboxBatchRepository(db));
    await Promise.all(stores.map(s => s.bootstrap()));
  });
  afterEach(async () => {
    await Promise.all((connections ?? []).map(db => db.destroy()));
    if (schema && admin)
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });
  function document(jobId = "jev_batch_" + "a".repeat(32)): BatchDocument {
    return { jobId, ownerId: "owner_1", agentId: "agent_1", binding: "b".repeat(64), activeRunId:"run_1", revision: 1, status: "ready", maxThreads: 100,
      createdAt: Date.now(), expiresAt: Date.now() + 86400000, queue: ["thread_1"], pageToken: "opaque-page", listed: true, items: [], pending: null, last: null, pages: [] };
  }
  it("admits one unfinished job and one step winner, preserves data after reconnect, and filters foreign owners", async () => {
    const opened = await Promise.all([stores[0]!.open(document()), stores[1]!.open(document("jev_batch_" + "c".repeat(32)))]);
    expect(opened[0]!.jobId).toBe(opened[1]!.jobId);
    const d = opened[0]!;
    const outcomes = await Promise.allSettled(stores.map(store => store.save({ ...d, revision: 2, status: "running", pending: { threadId: "thread_1", attempt: randomUUID(), runId: "run_1" } }, 1)));
    expect(outcomes.filter(x => x.status === "fulfilled")).toHaveLength(1);
    const reconnected = new JevInboxBatchRepository(connections[1]!);
    expect(await reconnected.get("owner_1", "agent_1", d.jobId)).toMatchObject({ status: "running", revision: 2, pageToken: "opaque-page", pending: { threadId: "thread_1" } });
    expect(await reconnected.get("owner_2", "agent_1", d.jobId)).toBeNull();
  });
  it("prevents a stale completion from overwriting a paused checkpoint", async () => {
    const d = await stores[0]!.open(document());
    const claimed = await stores[0]!.save({ ...d, revision: 2, status: "running", pending: { threadId: "thread_1", attempt: "claim", runId: "run_1" } }, 1);
    await stores[1]!.save({ ...claimed, revision: 3, status: "paused", pending: null, queue: [], items: [{ id: "thread_1", status: "unconfirmed", messages: 0 }] }, 2);
    await expect(stores[0]!.save({ ...claimed, revision: 3, status: "completed", pending: null }, 2)).rejects.toThrow();
    expect(await stores[0]!.get("owner_1", "agent_1", d.jobId)).toMatchObject({ status: "paused", items: [{ status: "unconfirmed" }] });
  });
});
