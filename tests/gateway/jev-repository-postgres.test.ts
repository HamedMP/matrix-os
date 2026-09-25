import { randomUUID } from "node:crypto";
import pg from "pg";
import { PostgresDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JevEvaluationRepository } from "../../packages/gateway/src/jev/repository.js";

// Only a disposable test server is appropriate: every test creates its own schema.
const databaseUrl = process.env.MATRIX_TEST_POSTGRES_URL;
const key = { ownerId: "owner_a", idempotencyKey: "thread:postgres123", payloadHash: "a".repeat(64) };

describe.skipIf(!databaseUrl)("Jev claims across independent PostgreSQL connections", () => {
  let admin: pg.Pool;
  let schema: string;
  let first: JevEvaluationRepository;
  let second: JevEvaluationRepository;
  let clock: Date;

  beforeEach(async () => {
    schema = `jev_claim_${randomUUID().replaceAll("-", "")}`;
    admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl!);
    url.searchParams.set("options", `-c search_path=${schema}`);
    clock = new Date("2026-09-22T10:00:00.000Z");
    first = new JevEvaluationRepository(new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 2 }),
    }), { now: () => clock });
    second = new JevEvaluationRepository(new PostgresDialect({
      pool: new pg.Pool({ connectionString: url.toString(), max: 2 }),
    }), { now: () => clock });
    await Promise.all([first.bootstrap(), second.bootstrap()]);
  });

  afterEach(async () => {
    await first?.destroy();
    await second?.destroy();
    if (schema && admin) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin?.end();
  });

  it("keeps one winner and preserves an unknown claim through concurrent retries after retention", async () => {
    const initial = await Promise.all([first.claim(key), second.claim(key)]);
    expect(initial.map((claim) => claim.kind).sort()).toEqual(["claimed", "pending"]);
    await first.markUnknown(key);
    clock = new Date(clock.getTime() + 7 * 24 * 60 * 60_000 + 1);

    const retries = await Promise.all([first.claim(key), second.claim(key)]);
    expect(retries).toEqual([{ kind: "unknown" }, { kind: "unknown" }]);
    await expect(second.claim({ ...key, payloadHash: "b".repeat(64) }))
      .resolves.toEqual({ kind: "conflict" });
    await expect(second.claim({ ...key, ownerId: "owner_b" }))
      .resolves.toEqual({ kind: "claimed" });
  });
});
