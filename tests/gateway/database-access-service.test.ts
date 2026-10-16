import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDatabaseAccessService, sealDatabasePassword, openDatabasePassword } from "../../packages/gateway/src/database-access/service.js";

const key = randomBytes(32);
const valid = { databaseUrl: "postgresql://matrix:service-password@127.0.0.1:5432/matrix", ownerId: "owner-1", key };

function harness() {
  let sealed: string | undefined;
  let role = false;
  let verifier: string | undefined;
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    statements.push({ sql, values });
    if (sql.includes("/* dedicated-runtime */")) return { rows: [{ dedicated: true }] };
    if (sql.includes("/* unsafe-role */")) return { rows: [{ unsafe: false, exists: role }] };
    if (sql.includes("/* unsafe-functions */") || sql.includes("/* unsafe-schema */")) return { rows: [{ unsafe: false }] };
    if (sql.includes("/* owner-credential */")) return { rows: sealed ? [{ owner_id: "owner-1", sealed }] : [] };
    if (sql.includes("/* app-schemas */")) return { rows: [{ name: "public" }, { name: "notes" }] };
    if (sql.startsWith("CREATE ROLE")) role = true;
    if (/^(?:CREATE|ALTER) ROLE/.test(sql)) verifier = sql.match(/PASSWORD '([^']+)'/)?.[1];
    if (sql.includes("/* role-password */")) return { rows: [{ verifier }] };
    if (sql.includes("/* save-credential */")) sealed = values?.[2] as string;
    return { rows: [] };
  });
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  const pool = { connect: vi.fn(async () => ({ query, release })), end, on: vi.fn() };
  const service = createDatabaseAccessService({ ...valid, poolFactory: () => pool as never });
  return { service, pool, query, statements, release, get sealed() { return sealed; }, set sealed(value) { sealed = value; }, set verifier(value: string) { verifier = value; } };
}

describe("owner database credentials", () => {
  it.each([
    "postgresql://matrix:pw@remote.example:5432/matrix", "postgresql://matrix:pw@localhost:5432/platform",
    "postgresql://matrix@127.0.0.1:5432/matrix", "postgresql://matrix:pw@[::1]:5432/matrix",
    "postgresql://matrix:pw@127.0.0.1:5432/matrix?options=-c%20role%3Dpostgres", "postgresql://postgres:pw@127.0.0.1/matrix",
    "postgresql://matrix:pw@[::1]:5432/matrix/evil", "http://127.0.0.1/matrix",
  ])("rejects unsupported or shared configurations before opening a pool: %s", (databaseUrl) => {
    const poolFactory = vi.fn();
    expect(() => createDatabaseAccessService({ ...valid, databaseUrl, poolFactory })).toThrow("Database access unavailable");
    expect(poolFactory).not.toHaveBeenCalled();
  });


  it("rejects invalid encryption keys and owner identifiers before opening a pool", () => {
    for (const overrides of [{ key: randomBytes(16) }, { ownerId: "" }, { ownerId: "owner with whitespace" }, { ownerId: "a".repeat(257) }]) {
      const poolFactory = vi.fn();
      expect(() => createDatabaseAccessService({ ...valid, ...overrides, poolFactory })).toThrow("Database access unavailable");
      expect(poolFactory).not.toHaveBeenCalled();
    }
  });

  it("never embeds the generated password into SQL text or query parameters", async () => {
    const h = harness();
    const credential = await h.service.reveal();
    expect(JSON.stringify(h.statements)).not.toContain(credential.password);
    expect(h.statements.find(({ sql }) => sql.startsWith("CREATE ROLE"))?.sql).toContain("SCRAM-SHA-256$");
    await h.service.close();
  });

  it("rejects a malformed or owner-mismatched encrypted credential, including reset", async () => {
    const h = harness();
    await h.service.reveal();
    h.sealed = sealDatabasePassword(key, "other-owner", "matrix", "wrong-password");
    await expect(h.service.reset()).rejects.toThrow("Database access unavailable");
    await expect(h.service.info()).rejects.toThrow("Database access unavailable");
    await h.service.close();
  });

  it("authenticates encryption to owner, database and key", () => {
    const sealed = sealDatabasePassword(key, "owner-1", "matrix", "secret");
    expect(sealed).not.toContain("secret");
    expect(openDatabasePassword(key, "owner-1", "matrix", sealed)).toBe("secret");
    expect(() => openDatabasePassword(key, "owner-2", "matrix", sealed)).toThrow();
    expect(() => openDatabasePassword(key, "owner-1", "other", sealed)).toThrow();
    expect(() => openDatabasePassword(randomBytes(32), "owner-1", "matrix", sealed)).toThrow();
    expect(() => openDatabasePassword(key, "owner-1", "matrix", "malformed")).toThrow();
  });

  it("returns safe connection information without allocating or exposing a password", async () => {
    const h = harness();
    expect(await h.service.info()).toEqual({ connection: { host: "127.0.0.1", port: 5432, database: "matrix", username: "matrix_owner" }, credentialReady: false });
    expect(JSON.stringify(await h.service.info())).not.toContain("service-password");
    expect(h.statements.some(({ sql }) => /CREATE ROLE|ALTER ROLE/.test(sql))).toBe(false);
    await h.service.close();
  });

  it("creates a separate restricted role, seals its secret, and locks rotation", async () => {
    const h = harness();
    const first = await h.service.reveal();
    expect(first.username).toBe("matrix_owner");
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.password).not.toBe("service-password");
    expect(h.sealed).not.toContain(first.password);
    expect(await h.service.reveal()).toEqual(first);
    expect((await h.service.info()).credentialReady).toBe(true);
    expect(h.statements.some(({ sql }) => sql.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(h.statements.find(({ sql }) => sql.startsWith("CREATE ROLE"))?.sql).toMatch(/NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS/);
    expect(h.statements.some(({ sql }) => /^GRANT "matrix" TO/.test(sql))).toBe(false);
    expect(h.statements.some(({ sql }) => /^GRANT.*(?:TRIGGER|REFERENCES)/.test(sql))).toBe(false);
    expect(h.statements.some(({ sql }) => sql.startsWith('GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ') && sql.includes('"notes"'))).toBe(true);
    await h.service.close();
  });


  it("reports externally changed passwords truthfully and requires an explicit reset", async () => {
    const h = harness();
    await h.service.reveal();
    h.verifier = "md5externally-changed";
    expect((await h.service.info()).credentialReady).toBe(false);
    await expect(h.service.reveal()).rejects.toThrow("Database access unavailable");
    await expect(h.service.consoleCommand()).rejects.toThrow("Database access unavailable");
    const reset = await h.service.reset();
    expect((await h.service.info()).credentialReady).toBe(true);
    expect(await h.service.reveal()).toEqual(reset);
    await h.service.close();
  });

  it("rotates atomically and never changes the service login", async () => {
    const h = harness();
    const before = await h.service.reveal();
    const after = await h.service.reset();
    expect(after.password).not.toBe(before.password);
    expect(await h.service.reveal()).toEqual(after);
    expect(h.statements.filter(({ sql }) => sql.startsWith("ALTER ROLE")).every(({ sql }) => sql.startsWith('ALTER ROLE "matrix_owner"'))).toBe(true);
    const passwordMutation = h.statements.findIndex(({ sql }) => sql.startsWith("ALTER ROLE"));
    expect(h.statements.slice(0, passwordMutation).some(({ sql }) => sql.toUpperCase() === "BEGIN")).toBe(true);
    expect(h.statements.slice(passwordMutation).some(({ sql }) => sql.toUpperCase() === "COMMIT")).toBe(true);
    await h.service.close();
  });

  it("rolls back and releases the connection after a credential write fails", async () => {
    const h = harness();
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => {
      if (sql.includes("/* save-credential */")) throw new Error("private host configuration");
      return original(sql, values);
    });
    await expect(h.service.reset()).rejects.toThrow("Database access unavailable");
    expect(h.statements.at(-1)?.sql.toUpperCase()).toBe("ROLLBACK");
    expect(h.release).toHaveBeenCalled();
    await h.service.close();
  });

  it.each(["dedicated-runtime", "unsafe-role", "unsafe-functions", "unsafe-schema"])("fails closed on unsafe database state: %s", async (marker) => {
    const h = harness();
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => sql.includes(`/* ${marker} */`)
      ? { rows: marker === "dedicated-runtime" ? [{ dedicated: false }] : [{ unsafe: true, exists: true }] } as never
      : original(sql, values));
    await expect(h.service.reveal()).rejects.toThrow("Database access unavailable");
    expect(h.statements.some(({ sql }) => sql.toUpperCase() === "COMMIT")).toBe(false);
    await h.service.close();
  });

  it("refuses an existing role without an owner-bound credential record", async () => {
    const h = harness();
    const original = h.query.getMockImplementation()!;
    h.query.mockImplementation(async (sql, values) => sql.includes("/* unsafe-role */") ? { rows: [{ unsafe: false, exists: true }] } as never : original(sql, values));
    await expect(h.service.reset()).rejects.toThrow("Database access unavailable");
    await h.service.close();
  });

  it("opens SQL with a password prompt and closes only its owned pool, once", async () => {
    const h = harness();
    await h.service.reveal();
    const command = await h.service.consoleCommand();
    expect(command).toBe("psql -h 127.0.0.1 -p 5432 -U matrix_owner -d matrix -W");
    expect(command).not.toContain((await h.service.reveal()).password);
    await h.service.close();
    await h.service.close();
    expect(h.pool.end).toHaveBeenCalledTimes(1);
    await expect(h.service.info()).rejects.toThrow("Database access unavailable");
  });
});
