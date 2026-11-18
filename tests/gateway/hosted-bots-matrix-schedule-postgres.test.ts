import { randomBytes } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { expect, it } from "vitest";
import { initializeHostedBotsScheduleStore } from "../../packages/gateway/src/hosted-bots/matrix-schedule-store.js";

const url = process.env.MATRIX_TEST_POSTGRES_URL;
const scope = { ownerId: "scope-a", machineId: "matrix-dev-a" };
const due = 1_900_000_000_000;
const prompt = "Return the synthetic Matrix schedule marker only.";
const intent = { botId: "Pebble", threadId: "source", modelId: "@cf/zai-org/glm-5.3-flash", scheduledFor: due, prompt };

it.skipIf(!url)("durably denies other scope, early, stale, and revoked claims and allows one concurrent consumption after a Gateway restart", async () => {
  const schema = "hosted_bots_schedule_" + randomBytes(8).toString("hex");
  const admin = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString: url, max: 1 }) }) });
  type StoreDb = Parameters<typeof initializeHostedBotsScheduleStore>[0];
  const open = (): StoreDb => new Kysely({
    dialect: new PostgresDialect({ pool: new pg.Pool({
      connectionString: url, max: 4, options: `-c search_path=${schema} -c statement_timeout=5000`,
    }) }),
  });
  const first = open(), restarted = open();
  try {
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    const before = await initializeHostedBotsScheduleStore(first, scope);
    const current = await initializeHostedBotsScheduleStore(restarted, scope);
    const otherComputer = await initializeHostedBotsScheduleStore(restarted, { ...scope, machineId: "matrix-dev-b" });
    const otherOwner = await initializeHostedBotsScheduleStore(restarted, { ...scope, ownerId: "scope-b" });
    const grant = (await before.issue(intent, due - 1000))!;
    const { prompt: _prompt, ...identity } = intent;
    const claim = { ...identity, routineId: grant.routineId };
    await first.destroy();
    expect(await otherComputer.consume(grant.token, claim, due)).toBeNull();
    expect(await otherOwner.consume(grant.token, claim, due)).toBeNull();
    expect(await current.consume(grant.token, claim, due - 1)).toBeNull();
    expect(await current.consume("d".repeat(64), claim, due)).toBeNull();
    expect(await current.consume(grant.token, { ...claim, threadId: "foreign" }, due)).toBeNull();
    expect(await current.consume(grant.token, { ...claim, modelId: "matrix-route-" + "a".repeat(64) }, due)).toBeNull();
    expect(await current.consume(grant.token, { ...claim, scheduledFor: due + 1 }, due + 1)).toBeNull();
    const results = await Promise.all([current.consume(grant.token, claim, due), current.consume(grant.token, claim, due)]);
    expect(results).toContain(prompt);
    expect(results).toContain(null);
    expect(await current.consume(grant.token, claim, due + 1)).toBeNull();

    const paused = (await current.issue(intent, due - 1000))!;
    await current.revoke(paused.routineId);
    expect(await current.consume(paused.token, { ...claim, routineId: paused.routineId }, due)).toBeNull();

    const expired = (await current.issue(intent, due - 1000))!;
    expect(await current.consume(expired.token, { ...claim, routineId: expired.routineId }, due + 12 * 60 * 60_000)).toBeNull();
  } finally {
    await Promise.allSettled([first.destroy(), restarted.destroy()]);
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
    await admin.destroy();
  }
}, 15_000);
