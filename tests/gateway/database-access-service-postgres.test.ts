import { randomBytes } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseAccessService, type DatabaseAccessService } from "../../packages/gateway/src/database-access/service.js";

// Dedicated disposable cluster only: exact matrix database, matrix superuser, no other application databases/roles.
const databaseUrl = process.env.MATRIX_OWNER_DATABASE_TEST_URL;
describe.skipIf(!databaseUrl)("owner database credentials on real PostgreSQL", () => {
  let admin: pg.Pool;
  let service: DatabaseAccessService;
  const key = randomBytes(32);
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
    await admin.query('CREATE SCHEMA IF NOT EXISTS notes');
    await admin.query('CREATE TABLE notes.example (id integer GENERATED ALWAYS AS IDENTITY, value text)');
    await admin.query("INSERT INTO notes.example (value) VALUES ('owner data')");
    await admin.query('CREATE FUNCTION notes.safe_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
    service = createDatabaseAccessService({ databaseUrl: databaseUrl!, ownerId: "test-owner", key });
  });
  afterAll(async () => {
    await service?.close();
    if (admin) {
      await admin.query('DROP SCHEMA IF EXISTS notes CASCADE');
      await admin.query('DROP SCHEMA IF EXISTS later_app CASCADE');
      await admin.query('DROP SCHEMA IF EXISTS _matrix_owner_access CASCADE');
      if ((await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'matrix_owner'")).rowCount) {
        await admin.query('DROP OWNED BY matrix_owner');
        await admin.query('DROP ROLE matrix_owner');
      }
      await admin.end();
    }
  });

  async function connect(password: string) {
    const url = new URL(databaseUrl!);
    url.username = "matrix_owner";
    url.password = password;
    const client = new pg.Client({ connectionString: url.toString(), connectionTimeoutMillis: 2_000 });
    await client.connect();
    return client;
  }

  it("authenticates the generated SCRAM password and enforces data/role boundaries", async () => {
    const first = await service.reveal();
    const owner = await connect(first.password);
    try {
      expect((await owner.query('SELECT value FROM notes.example')).rows).toEqual([{ value: "owner data" }]);
      await owner.query("INSERT INTO notes.example (value) VALUES ('from SQL')");
      expect((await owner.query('SELECT count(*)::int AS count FROM notes.example')).rows[0].count).toBe(2);
      for (const sql of [
        'SELECT * FROM _matrix_owner_access.credentials', 'SELECT rolpassword FROM pg_authid',
        'SET ROLE matrix', 'CREATE ROLE escalation SUPERUSER', "COPY notes.example TO '/tmp/owner-export'",
        'CREATE TABLE public.escalation (id int)', 'CREATE DATABASE escalation',
        "CREATE TRIGGER escalation BEFORE INSERT ON notes.example FOR EACH ROW EXECUTE FUNCTION notes.safe_trigger()",
      ]) await expect(owner.query(sql)).rejects.toThrow();
    } finally { await owner.end(); }
  });

  it("preserves concurrent reveals and changes only new owner connections on reset", async () => {
    const [a, b] = await Promise.all([service.reveal(), service.reveal()]);
    expect(a).toEqual(b);
    const existing = await connect(a.password);
    const reset = await service.reset();
    expect(reset.password).not.toBe(a.password);
    const staleUrl = new URL(databaseUrl!);
    staleUrl.username = 'matrix_owner';
    staleUrl.password = a.password;
    const stale = new pg.Client({ connectionString: staleUrl.toString(), connectionTimeoutMillis: 2_000 });
    await expect(stale.connect()).rejects.toThrow();
    await stale.end();
    expect((await existing.query('SELECT 1 AS works')).rows[0].works).toBe(1);
    await existing.end();
    const fresh = await connect(reset.password);
    await fresh.end();
    expect((await admin.query('SELECT current_user AS role')).rows[0].role).toBe('matrix');
  });

  it("rolls back a failed grant without replacing the live password", async () => {
    const previous = await service.reveal();
    await admin.query('CREATE FUNCTION public.unsafe_owner_function() RETURNS text LANGUAGE sql SECURITY DEFINER AS $$ SELECT current_user::text $$');
    await expect(service.reset()).rejects.toThrow('Database access unavailable');
    const owner = await connect(previous.password);
    await owner.end();
    await admin.query('DROP FUNCTION public.unsafe_owner_function()');
    expect(await service.reveal()).toEqual(previous);
  });


  it("rejects a shared cluster before disclosing connection information", async () => {
    await admin.query('CREATE DATABASE another_owner');
    try { await expect(service.info()).rejects.toThrow('Database access unavailable'); }
    finally { await admin.query('DROP DATABASE another_owner'); }
  });

  it("rejects externally elevated role privileges and wrong encryption keys", async () => {
    await admin.query('ALTER ROLE matrix_owner CREATEROLE');
    try { await expect(service.reveal()).rejects.toThrow('Database access unavailable'); }
    finally { await admin.query('ALTER ROLE matrix_owner NOCREATEROLE'); }
    const wrongKey = createDatabaseAccessService({ databaseUrl: databaseUrl!, ownerId: 'test-owner', key: randomBytes(32) });
    try { await expect(wrongKey.reset()).rejects.toThrow('Database access unavailable'); }
    finally { await wrongKey.close(); }
  });


  it("detects an external password change and recovers only through explicit reset", async () => {
    const before = await service.reveal();
    const owner = await connect(before.password);
    try { await owner.query("ALTER ROLE matrix_owner PASSWORD 'changed-outside-settings'"); }
    finally { await owner.end(); }
    expect((await service.info()).credentialReady).toBe(false);
    await expect(service.reveal()).rejects.toThrow('Database access unavailable');
    await expect(service.consoleCommand()).rejects.toThrow('Database access unavailable');
    const reset = await service.reset();
    const fresh = await connect(reset.password);
    await fresh.end();
    expect((await service.info()).credentialReady).toBe(true);
  });

  it("reconciles new schemas on an explicit action and future tables within existing schemas", async () => {
    const credential = await service.reveal();
    const owner = await connect(credential.password);
    try {
      await admin.query('CREATE TABLE notes.future_table (id int)');
      await owner.query('INSERT INTO notes.future_table VALUES (1)');
      await admin.query('CREATE SCHEMA later_app');
      await admin.query('CREATE TABLE later_app.example (id int)');
      await expect(owner.query('SELECT * FROM later_app.example')).rejects.toThrow();
      await service.consoleCommand();
      await owner.query('INSERT INTO later_app.example VALUES (1)');
      expect((await owner.query('SELECT id FROM later_app.example')).rows).toEqual([{ id: 1 }]);
    } finally { await owner.end(); }
  });
});
