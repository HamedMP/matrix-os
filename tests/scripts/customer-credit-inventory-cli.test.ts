import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { formatCustomerCreditInventoryError, parseCustomerCreditInventoryArguments, runCustomerCreditInventory } from "../../scripts/inventory-expired-customer-credit";

const state = vi.hoisted(() => ({
  connectFailure: undefined as unknown, queryFailure: undefined as unknown, generation: 23,
  queries: [] as string[], options: undefined as unknown, ends: 0, listener: undefined as undefined | ((error: Error) => void),
}));
vi.mock("pg", async importOriginal => {
  const actual = await importOriginal<typeof import("pg")>();
  class Pool {
    constructor(options: unknown) { state.options = options; }
    on(_event: string, listener: (error: Error) => void) { state.listener = listener; return this; }
    async connect() {
      if (state.connectFailure !== undefined) throw state.connectFailure;
      return { query: async (text: string) => {
        state.queries.push(text);
        if (text.includes("platform_schema_revisions")) {
          if (state.queryFailure !== undefined) throw state.queryFailure;
          return { rows: [{ generation: state.generation }], command: "SELECT", rowCount: 1 };
        }
        return { rows: [], command: "SELECT", rowCount: 0 };
      }, release() {} };
    }
    async end() { state.ends++; }
  }
  return { ...actual, default: { ...actual.default, Pool } };
});
beforeEach(() => {
  state.connectFailure = undefined; state.queryFailure = undefined; state.generation = 23;
  state.queries = []; state.options = undefined; state.ends = 0; state.listener = undefined;
});
afterEach(() => vi.restoreAllMocks());

function invoke(args: string[], databaseUrl = "") {
  return spawnSync("bun", ["scripts/inventory-expired-customer-credit.ts", ...args], {
    env: { ...process.env, PLATFORM_DATABASE_URL: databaseUrl }, encoding: "utf8", timeout: 20_000,
  });
}

describe("read-only customer credit inventory diagnostics", () => {
  it.each([
    [["1", "cursor", "extra"], "category=input code=USAGE"],
    [["1001"], "category=input code=INVALID_ARGUMENTS"],
    [["1", Buffer.from('{"private-cursor":').toString("base64url")], "category=input code=CURSOR_JSON"],
    [[], "category=configuration code=MISSING_DATABASE_URL"],
  ])("keeps the actual CLI failure safe and classified for %j", (args, diagnostic) => {
    const result = invoke(args);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Customer credit inventory failed; no financial changes were applied");
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).not.toContain("private-cursor");
  });

  it.each([
    ["not-a-url-private-credential", "INVALID_DATABASE_URL"],
    ["postgres://private-user:private-password@database.invalid/db", "TLS_REQUIRED"],
  ])("rejects unsafe configuration before constructing a pool", async (url, code) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCustomerCreditInventory([], { PLATFORM_DATABASE_URL: url })).toBe(1);
    expect(error.mock.calls.flat().join(" ")).toContain(`category=configuration code=${code}`);
    expect(error.mock.calls.flat().join(" ")).not.toContain("private-");
    expect(state.options).toBeUndefined();
  });

  it("retains bounded cursor parsing and rejects schema 23 in a read-only transaction", async () => {
    expect(parseCustomerCreditInventoryArguments([])).toEqual({ limit: 100, after: undefined });
    const cursor = { expiresAt: "2026-11-04T00:00:00.000Z", reservationId: "request-1" };
    expect(parseCustomerCreditInventoryArguments(["1000", Buffer.from(JSON.stringify(cursor)).toString("base64url")])).toEqual({ limit: 1000, after: cursor });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await runCustomerCreditInventory(["1"], { PLATFORM_DATABASE_URL: "postgres://localhost/disposable" })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("category=schema code=SCHEMA_TOO_OLD"));
    expect(output).not.toHaveBeenCalled();
    expect(state.options).toMatchObject({ max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 15_000,
      lock_timeout: 5_000, options: "-c default_transaction_read_only=on" });
    expect(state.queries.some(query => query.includes("repeatable read"))).toBe(true);
    expect(state.queries).toContain("SET TRANSACTION READ ONLY");
    expect(state.queries.some(query => /\b(?:update|insert|delete|create|alter)\b/i.test(query))).toBe(false);
    expect(state.ends).toBe(1);
  });

  it.each([
    ["ECONNREFUSED", "connection"], ["ETIMEDOUT", "timeout"],
  ])("classifies connection failure %s and closes the pool", async (code, category) => {
    state.connectFailure = Object.assign(new Error("private-connection-url"), { code, name: "private-name", cause: "private-cause" });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCustomerCreditInventory(["1"], { PLATFORM_DATABASE_URL: "postgres://localhost/disposable" })).toBe(1);
    const report = error.mock.calls.flat().join(" ");
    expect(report).toContain(`category=${category} code=${code}`);
    expect(report).not.toContain("private-");
    expect(state.ends).toBe(1);
  });

  it.each(["timeout exceeded when trying to connect", "Connection terminated due to connection timeout"])("classifies the fixed pg-pool timeout %s without its cause", async message => {
    state.connectFailure = new Error(message, { cause: new Error("private-database-url") });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCustomerCreditInventory(["1"], { PLATFORM_DATABASE_URL: "postgres://localhost/disposable" })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("category=timeout code=POOL_CONNECTION_TIMEOUT"));
    expect(error.mock.calls.flat().join(" ")).not.toContain(message);
    expect(error.mock.calls.flat().join(" ")).not.toContain("private-");
  });

  it("keeps successful inventory read-only and emits the existing JSON result", async () => {
    state.generation = 24;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCustomerCreditInventory(["1"], { PLATFORM_DATABASE_URL: "postgres://localhost/disposable" })).toBe(0);
    expect(JSON.parse(output.mock.calls[0]![0])).toMatchObject({ hasMore: false, items: [], nextCursor: null });
    expect(error).not.toHaveBeenCalled();
    expect(state.queries).toContain("SET TRANSACTION READ ONLY");
    expect(state.queries.some(query => /\b(?:update|insert|delete|create|alter)\b/i.test(query))).toBe(false);
    expect(state.ends).toBe(1);
  });

  it("classifies a real PostgreSQL statement timeout and idle pool errors consistently", async () => {
    const failure = new pg.DatabaseError("private-query-and-credential", 1, "error"); failure.code = "57014";
    state.queryFailure = failure;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await runCustomerCreditInventory(["1"], { PLATFORM_DATABASE_URL: "postgres://localhost/disposable" })).toBe(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("category=timeout code=57014"));
    state.listener!(Object.assign(new Error("private-pool-error"), { code: "ECONNRESET" }));
    expect(error).toHaveBeenLastCalledWith("Operator database connection failed [category=connection code=ECONNRESET]");
    expect(error.mock.calls.flat().join(" ")).not.toContain("private-");
    expect(state.ends).toBe(1);
  });

  it("does not echo arbitrary error codes, names, messages, causes or lookalike objects", () => {
    for (const failure of [Object.assign(new Error("private-message"), { code: "private-code", name: "private-name", cause: "private-cause" }),
      { name: "DatabaseError", code: "57014", message: "private-message" }, undefined]) {
      const report = formatCustomerCreditInventoryError(failure);
      expect(report).toContain("code=UNCLASSIFIED");
      expect(report).not.toContain("private-");
      expect(report.length).toBeLessThan(180);
    }
  });

});
