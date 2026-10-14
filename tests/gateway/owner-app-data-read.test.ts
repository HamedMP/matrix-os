import { describe, expect, it, vi } from "vitest";
import {
  ownerReadFixture, registerReadRoutes, fiveRows, READ_PATH, OWNER, RUN, RUNTIME,
  DEFAULT_ROWS, MAX_ROWS, MAX_BYTES, BODY_BYTES, MACHINE_SECRET, DATABASE_SECRET,
} from "./owner-app-data-read-fixture.js";

describe("ENG-289 dedicated owner app-data read boundary", () => {
  it("registers a dedicated read route rather than granting the mixed write bridge", async () => {
    expect(registerReadRoutes, "Missing dedicated owner app-data read route registration").toBeTypeOf("function");
    const f = await ownerReadFixture();
    expect(f.capabilities.resolveRunContext(f.grant.token, "POST", READ_PATH)).toMatchObject({
      actorId: OWNER.ownerId, runId: RUN,
      appDataRead: { runtimeHandle: RUNTIME, apps: [{ app: "notes", schema: "notes", tables: ["entries"] }] },
    });
    expect(f.capabilities.resolve(f.grant.token, "POST", "/api/bridge/query")).toBeNull();
  });

  it("discovers only the granted installed app and its declared schema", async () => {
    const f = await ownerReadFixture();
    const list = await f.request({ action: "listApps" });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ apps: [{ app: "notes", schema: "notes" }] });
    const response = await f.request({ action: "schema", app: "notes" });
    expect(response.status).toBe(200);
    const schema = await response.json();
    expect(schema).toMatchObject({ app: "notes", schema: "notes", tables: { entries: expect.any(Object) } });
    expect(JSON.stringify(schema)).not.toMatch(/hidden|restricted|private_app|password|DATABASE_URL/);
    expect(f.writes.every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  it("reads five deterministically ordered PG records and audits exact authority without side effects", async () => {
    const f = await ownerReadFixture();
    const response = await f.request(fiveRows);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows.map((row: { title: string }) => row.title)).toEqual(["note-1", "note-2", "note-3", "note-4", "note-5"]);
    expect(f.find).toHaveBeenCalledWith("notes", "entries", expect.objectContaining({ limit: 5 }));
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER.ownerId, runId: RUN,
      runtimeHandle: RUNTIME, app: "notes", action: "find", outcome: "allowed" }));
    expect(f.writes.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(await f.engine.find("notes", "entries", { orderBy: { position: "asc" } })).toEqual(f.before);
    expect(JSON.stringify(body)).not.toMatch(/db-secret|machine-secret/);
    expect(JSON.stringify(f.audit.mock.calls)).not.toMatch(/db-secret|machine-secret|note-1/);
  });

  it.each([undefined, MAX_ROWS])("enforces default/maximum SQL row bounds (%s)", async limit => {
    const f = await ownerReadFixture({ rows: MAX_ROWS + 5 });
    const response = await f.request({ ...fiveRows, limit });
    expect(response.status).toBe(200);
    const expected = limit ?? DEFAULT_ROWS;
    expect((await response.json()).rows).toHaveLength(expected);
    expect(f.find).toHaveBeenCalledWith("notes", "entries", expect.objectContaining({ limit: expected }));
    expect(f.raw.mock.calls.some(([sql]) => /\bLIMIT\s+\d+\b/i.test(sql))).toBe(true);
  });

  it.each([
    ["cross-app", { ...fiveRows, app: "private_app" }, 403],
    ["declared but ungranted table", { ...fiveRows, table: "restricted" }, 403],
    ["undeclared physical table", { ...fiveRows, table: "hidden" }, 403],
    ["schema override", { ...fiveRows, schema: "private_app" }, 400],
    ["owner override", { ...fiveRows, ownerId: "owner_other" }, 400],
    ["run override", { ...fiveRows, runId: "run_other" }, 400],
    ["runtime override", { ...fiveRows, runtimeHandle: "runtime_other" }, 400],
    ["SQL", { action: "sql", sql: "SELECT * FROM private_app.entries" }, 400],
    ["SQL attached to find", { ...fiveRows, sql: "DROP SCHEMA notes CASCADE" }, 400],
    ["mutation", { ...fiveRows, action: "delete", id: "1" }, 400],
    ["injected identifier", { ...fiveRows, table: 'entries"; DELETE FROM notes.entries; --' }, 400],
    ["oversized row limit", { ...fiveRows, limit: MAX_ROWS + 1 }, 400],
    ["negative limit", { ...fiveRows, limit: -1 }, 400],
    ["fractional limit", { ...fiveRows, limit: 1.5 }, 400],
    ["malformed filter", { ...fiveRows, filter: { position: { $sql: "1=1" } } }, 400],
    ["malformed order", { ...fiveRows, orderBy: { title: "sideways" } }, 400],
  ] as const)("rejects and audits %s before reading PG", async (_name, body, status) => {
    const f = await ownerReadFixture();
    const response = await f.request(body);
    expect(response.status).toBe(status);
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.writes.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
    expect(await response.text()).not.toMatch(/SELECT|DROP|private_app|undeclared-secret|db-secret|Zod/);
  });

  it.each(["revoked", "expired", "identity-forgery", "foreign-token", "machine-token", "unscoped-run"])("denies and audits %s", async scenario => {
    const f = await ownerReadFixture();
    if (scenario === "revoked") f.grant.revoke();
    if (scenario === "expired") f.expire();
    const unscoped = scenario === "unscoped-run" ? f.capabilities.issue({ owner: OWNER, runId: "run_no_read", scope: "chat_call" })! : null;
    const extra = scenario === "identity-forgery"
      ? { "x-platform-user-id": "owner_other", "x-platform-verified": "forged" }
      : scenario === "machine-token" ? { authorization: `Bearer ${MACHINE_SECRET}` }
      : unscoped ? { authorization: `Bearer ${unscoped.token}` }
      : scenario === "foreign-token" ? { authorization: `Bearer ${"a".repeat(64)}` } : {};
    const response = await f.request(fiveRows, extra);
    expect(response.status).toBe(401);
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects cross-owner issuance and a capability replayed at another runtime", async () => {
    const f = await ownerReadFixture({ runtime: "runtime_owner_b" });
    expect(f.capabilities.issue({ ...f.grantInput, owner: { ...OWNER, ownerId: "owner_other" } })).toBeNull();
    const response = await f.request(fiveRows);
    expect(response.status).toBe(401);
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("rejects oversized input before parsing or executing a read", async () => {
    const f = await ownerReadFixture();
    const response = await f.gateway.request(READ_PATH, { method: "POST", headers: f.headers,
      body: JSON.stringify({ ...fiveRows, filter: { title: "x".repeat(BODY_BYTES + 1) } }) });
    expect(response.status).toBe(413);
    expect(f.raw).not.toHaveBeenCalled();
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "denied" }));
  });

  it("bounds UTF-8 output and returns no oversized record or internal error", async () => {
    const f = await ownerReadFixture();
    await f.engine.update("notes", "entries", f.before[0].id as string, { title: "界".repeat(Math.floor(MAX_BYTES / 2)) });
    const encoded = JSON.stringify({ rows: await f.engine.find("notes", "entries", { limit: 5, orderBy: { position: "asc", id: "asc" } }) });
    expect(encoded.length).toBeLessThan(MAX_BYTES);
    expect(Buffer.byteLength(encoded)).toBeGreaterThan(MAX_BYTES);
    vi.clearAllMocks();
    const response = await f.request(fiveRows);
    expect(response.status).toBe(413);
    const body = await response.text();
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_BYTES);
    expect(body).not.toContain("界");
    expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
    expect(f.writes.every(spy => spy.mock.calls.length === 0)).toBe(true);
  });

  it("rechecks live authority after a read has started", async () => {
    const f = await ownerReadFixture();
    f.find.mockImplementationOnce(async () => { f.grant.revoke(); return [{ title: "must-not-escape" }]; });
    const response = await f.request(fiveRows);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("must-not-escape");
  });

  it("validates and copies app/schema/table grants at issuance", async () => {
    const f = await ownerReadFixture();
    for (const app of [{ app: "notes", schema: "public", tables: ["users"] },
      { app: "notes", schema: "private_app", tables: ["entries"] },
      { app: "pg_catalog", schema: "pg_catalog", tables: ["pg_authid"] }]) {
      expect(f.capabilities.issue({ ...f.grantInput, appDataRead: { runtimeHandle: RUNTIME, apps: [app] } })).toBeNull();
    }
    f.grantInput.appDataRead.apps[0]!.tables.push("restricted");
    expect((await f.request({ ...fiveRows, table: "restricted" })).status).toBe(403);
  });

  it("bounds unauthenticated audit work independently of owner read traffic", async () => {
    const f = await ownerReadFixture();
    for (let i = 0; i < 120; i++) {
      expect((await f.request(fiveRows, { authorization: "Bearer invalid" })).status).toBe(401);
    }
    expect((await f.request(fiveRows, { authorization: "Bearer invalid" })).status).toBe(429);
    expect(f.audit).toHaveBeenCalledTimes(120);
    expect((await f.request(fiveRows)).status).toBe(200);
  });

  it("denies URL/method aliases and an unknown filter column before the record query", async () => {
    const f = await ownerReadFixture();
    expect((await f.gateway.request(READ_PATH, { headers: f.headers })).status).toBe(401);
    expect(f.capabilities.resolve(f.grant.token, "POST", READ_PATH + "/")).toBeNull();
    expect(f.capabilities.resolve(f.grant.token, "POST", READ_PATH.replace("read", "%72ead"))).toBeNull();
    expect((await f.request({ ...fiveRows, filter: { undeclared: "data" } })).status).toBe(400);
    expect(f.raw).not.toHaveBeenCalled();
  });

  it("fails closed with generic 503 when audit persistence fails", async () => {
    const f = await ownerReadFixture();
    f.audit.mockRejectedValue(new Error("postgres://private-secret"));
    const response = await f.request(fiveRows);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "App data read unavailable" });
  });

  it("projects declared columns and paginates with an implicit id tie-breaker", async () => {
    const f = await ownerReadFixture();
    await f.db.raw("ALTER TABLE notes.entries ADD COLUMN undeclared text DEFAULT 'private-column'");
    f.raw.mockClear();
    const response = await f.request({ action: "find", app: "notes", table: "entries", limit: 2, offset: 2 });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.rows.map((r: { title: string }) => r.title)).toEqual(["note-3", "note-4"]);
    expect(JSON.stringify(body)).not.toContain("private-column");
    expect(f.find).toHaveBeenCalledWith("notes", "entries", expect.objectContaining({ orderBy: { id: "asc" }, offset: 2 }));
  });

  it("distinguishes empty records from generic database unavailability without credential exposure", async () => {
    const f = await ownerReadFixture();
    const empty = await f.request({ ...fiveRows, filter: { position: -1 } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ rows: [] });
    f.raw.mockRejectedValueOnce(new Error(`${DATABASE_SECRET} SELECT * FROM notes.entries`));
    const response = await f.request(fiveRows);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "App data read unavailable" });
    expect(JSON.stringify(f.audit.mock.calls)).not.toMatch(/postgres:|db-secret|SELECT|machine-secret/);
    expect(f.writes.every(spy => spy.mock.calls.length === 0)).toBe(true);
    expect(f.headers.authorization).not.toContain(MACHINE_SECRET);
  });
});
