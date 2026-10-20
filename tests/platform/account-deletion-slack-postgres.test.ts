import { createHash, randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlatformDB, PlatformDatabase } from "../../packages/platform/src/db.js";
import { bootstrapPlatformSlack } from "../../packages/platform/src/slack-startup.js";
import { migrateAccountDeletion } from "../../packages/platform/src/database/migrations/account-deletion.js";
import { AccountDeletionRepository } from "../../packages/platform/src/account-deletion/repository.js";

const connectionString = process.env.MATRIX_TEST_POSTGRES_URL;
const actor = "user_slack_delete", secret = "synthetic-slack-owner-deletion-secret";
const token = "a".repeat(43), hash = createHash("sha256").update(token).digest("hex");
const env = { SLACK_APP_ID: "A123", SLACK_CLIENT_ID: "123.456", SLACK_CLIENT_SECRET: "c".repeat(32),
  SLACK_SIGNING_SECRET: "s".repeat(32), SLACK_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
  SLACK_PUBLIC_BASE_URL: "https://app.matrix-os.com", ACCOUNT_DELETION_SECRET: secret };
describe.skipIf(!connectionString)("Slack link admission shares the account deletion owner transaction on PostgreSQL", () => {
  let admin: Kysely<PlatformDatabase>, db: Kysely<PlatformDatabase>, schema: string;
  let slack: Awaited<ReturnType<typeof bootstrapPlatformSlack>>;
  const wrap = (executor: PlatformDB["executor"]): PlatformDB => ({ kysely: db, executor, ready: Promise.resolve(), destroy: async () => {},
    transaction: work => executor === db ? db.transaction().execute(trx => work(wrap(trx))) : work(wrap(executor)) });
  async function start(deletionSecret: string | undefined) {
    slack = await bootstrapPlatformSlack({ env: { ...env, ACCOUNT_DELETION_SECRET: deletionSecret }, db: wrap(db),
      platformSecret: "synthetic-platform-secret", platformJwtSecret: "synthetic-jwt-secret", startCleanup: false,
      clerkAuth: { extractToken: () => "synthetic-owner", verify: async () => ({ authenticated: true, userId: actor }) } as never,
      collaboration: { repository: {}, organizations: { projection: { isCurrentMember: async () => true } } } as never });
    if (!("repository" in slack)) throw new Error("Synthetic Slack fixture did not start");
    await slack.repository.saveInstallation({ appId: "A123", teamId: "T123", organizationId: "org_team", installedBy: actor,
      botUserId: "UBOT", encryptedBotToken: "synthetic-unused" });
    await slack.repository.createChallenge({ hash, appId: "A123", teamId: "T123", slackUserId: "U123" });
  }
  const link = () => slack.routes.request("/api/slack/link/complete", { method: "POST",
    headers: { authorization: "Bearer synthetic-owner", "content-type": "application/json" }, body: JSON.stringify({ token }) });
  const links = () => sql`SELECT actor_id FROM slack_employee_links`.execute(db);
  beforeEach(async () => {
    schema = `slack_delete_${randomUUID().replaceAll("-", "")}`;
    admin = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 1 }) }) });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    db = new Kysely({ dialect: new PostgresDialect({ pool: new Pool({ connectionString, max: 4, application_name: schema,
      options: `-c search_path=${schema},public` }) }) });
    await migrateAccountDeletion(db); await start(secret);
  });
  afterEach(async () => { await slack.close(); await db.destroy(); await sql`DROP SCHEMA ${sql.id(schema)} CASCADE`.execute(admin); await admin.destroy(); });
  it("rejects a link after deletion acceptance without consuming its challenge", async () => {
    await new AccountDeletionRepository(db, { secret }).accept({ clerkUserId: actor, appleTokens: [] }, false);
    expect((await link()).status).toBe(503); expect((await links()).rows).toHaveLength(0);
    expect((await sql<{ consumed_at: unknown }>`SELECT consumed_at FROM slack_link_challenges WHERE hash=${hash}`.execute(db)).rows[0].consumed_at).toBeNull();
  });
  it("waits behind deletion's actual owner lock and cannot resurrect a link after acceptance", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const accepting = new AccountDeletionRepository(db, { secret }).acceptPrepared(actor, false, async () => {
      entered(); await gate; return { clerkUserId: actor, appleTokens: [] };
    });
    await started;
    const linking = link();
    let waiting = false;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await sql<{ waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid
          WHERE lock.locktype='advisory' AND NOT lock.granted AND activity.application_name=${schema}) AS waiting`.execute(admin);
        if (result.rows[0].waiting) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally { release(); await accepting; }
    const response = await linking;
    expect(waiting).toBe(true); expect(response.status).toBe(503); expect((await links()).rows).toHaveLength(0);
  });
  it("keeps deletion acceptance behind the actual admitted link write transaction", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const installed = db.transaction().execute(async trx => {
      await sql`SELECT app_id FROM slack_installations WHERE app_id='A123' FOR UPDATE`.execute(trx);
      entered(); await gate;
    });
    await started; const linking = link();
    let accepting: ReturnType<AccountDeletionRepository["accept"]> | undefined;
    let ownerWaiting = false;
    try {
      let writeWaiting = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = await sql<{ waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=${schema}
          AND wait_event_type='Lock' AND query ILIKE '%slack_installations%') AS waiting`.execute(admin);
        if (row.rows[0].waiting) { writeWaiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!writeWaiting) throw new Error("Synthetic installation lock was not reached");
      accepting = new AccountDeletionRepository(db, { secret }).accept({ clerkUserId: actor, appleTokens: [] }, false);
      for (let attempt = 0; attempt < 100; attempt++) {
        const row = await sql<{ waiting: boolean }>`SELECT EXISTS (SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid=lock.pid
          WHERE lock.locktype='advisory' AND NOT lock.granted AND activity.application_name=${schema}) AS waiting`.execute(admin);
        if (row.rows[0].waiting) { ownerWaiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    } finally { release(); await installed; }
    const response = await linking; await accepting;
    expect(ownerWaiting).toBe(true); expect(response.status).toBe(200);
    expect((await links()).rows).toEqual([{ actor_id: actor }]);
  });
  it("does not block another owner's valid link", async () => {
    await new AccountDeletionRepository(db, { secret }).accept({ clerkUserId: "user_other", appleTokens: [] }, false);
    expect((await link()).status).toBe(200); expect((await links()).rows).toEqual([{ actor_id: actor }]);
  });
  it("preserves normal linking when account deletion is disabled", async () => {
    await slack.close(); await sql`DELETE FROM slack_link_challenges`.execute(db); await start(undefined);
    expect((await link()).status).toBe(200); expect((await links()).rows).toEqual([{ actor_id: actor }]);
  });
});
