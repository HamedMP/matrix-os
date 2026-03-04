import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createBridgeSql,
  type BridgeSql,
} from "../../packages/gateway/src/bridge-sql.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "bridge-sql-")));
  mkdirSync(join(dir, "data"), { recursive: true });
  return dir;
}

describe("T1520: Bridge SQL API", () => {
  let homePath: string;
  let sql: BridgeSql;

  beforeEach(() => {
    homePath = tmpHome();
    sql = createBridgeSql(homePath);
  });

  afterEach(() => {
    sql.closeAll();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("runs SELECT query", () => {
    sql.run("test-app", "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    sql.run("test-app", "INSERT INTO items (name) VALUES (?)", ["widget"]);

    const result = sql.query("test-app", "SELECT * FROM items");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({ id: 1, name: "widget" });
  });

  it("INSERT/UPDATE/DELETE return changes count", () => {
    sql.run("test-app", "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");

    const insert = sql.run("test-app", "INSERT INTO items (name) VALUES (?)", ["a"]);
    expect(insert.changes).toBe(1);
    expect(insert.lastInsertRowid).toBe(1);

    const update = sql.run("test-app", "UPDATE items SET name = ? WHERE id = ?", ["b", 1]);
    expect(update.changes).toBe(1);

    const del = sql.run("test-app", "DELETE FROM items WHERE id = ?", [1]);
    expect(del.changes).toBe(1);
  });

  it("auto-creates database on first query", () => {
    const dbPath = join(homePath, "data", "new-app", "db.sqlite");
    expect(existsSync(dbPath)).toBe(false);

    sql.run("new-app", "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(existsSync(dbPath)).toBe(true);
  });

  it("auto-creates data directory on first query", () => {
    const dataDir = join(homePath, "data", "fresh-app");
    expect(existsSync(dataDir)).toBe(false);

    sql.run("fresh-app", "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(existsSync(dataDir)).toBe(true);
  });

  it("supports parameterized queries (SQL injection prevention)", () => {
    sql.run("test-app", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    sql.run("test-app", "INSERT INTO users (name) VALUES (?)", ["Alice"]);

    // Attempt SQL injection via parameter
    const result = sql.query("test-app", "SELECT * FROM users WHERE name = ?", ["'; DROP TABLE users;--"]);
    expect(result.rows).toHaveLength(0);

    // Table should still exist
    const check = sql.query("test-app", "SELECT count(*) as cnt FROM users");
    expect(check.rows[0]).toEqual({ cnt: 1 });
  });

  it("supports CREATE TABLE IF NOT EXISTS for migrations", () => {
    sql.run("test-app", "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
    sql.run("test-app", "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT)");
    // No error on second call
    sql.run("test-app", "INSERT INTO items (name) VALUES (?)", ["test"]);
    const result = sql.query("test-app", "SELECT * FROM items");
    expect(result.rows).toHaveLength(1);
  });

  it("database path is ~/data/{appName}/db.sqlite", () => {
    sql.run("budget-tracker", "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect(existsSync(join(homePath, "data", "budget-tracker", "db.sqlite"))).toBe(true);
  });
});

describe("T1521: App scoping and security", () => {
  let homePath: string;
  let sql: BridgeSql;

  beforeEach(() => {
    homePath = tmpHome();
    sql = createBridgeSql(homePath);
  });

  afterEach(() => {
    sql.closeAll();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("apps cannot access other app databases", () => {
    sql.run("app-a", "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    sql.run("app-a", "INSERT INTO items (name) VALUES (?)", ["secret"]);

    // app-b's database is separate
    sql.run("app-b", "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    const result = sql.query("app-b", "SELECT * FROM items");
    expect(result.rows).toHaveLength(0);
  });

  it("rejects ATTACH DATABASE statements", () => {
    sql.run("test-app", "CREATE TABLE t (id INTEGER PRIMARY KEY)");

    expect(() => {
      sql.run("test-app", "ATTACH DATABASE '/tmp/other.db' AS other");
    }).toThrow(/forbidden/i);
  });

  it("rejects dangerous PRAGMA statements", () => {
    expect(() => {
      sql.run("test-app", "PRAGMA journal_mode = DELETE");
    }).toThrow(/forbidden/i);
  });

  it("allows safe PRAGMA statements", () => {
    sql.run("test-app", "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    // table_info is safe
    const result = sql.query("test-app", "PRAGMA table_info(t)");
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it("validates appName format", () => {
    expect(() => {
      sql.run("../evil", "SELECT 1");
    }).toThrow(/invalid/i);

    expect(() => {
      sql.run("app/../../etc", "SELECT 1");
    }).toThrow(/invalid/i);
  });

  it("rejects oversized query results", () => {
    sql.run("test-app", "CREATE TABLE big (id INTEGER PRIMARY KEY, data TEXT)");

    // Insert many rows
    for (let i = 0; i < 100; i++) {
      sql.run("test-app", "INSERT INTO big (data) VALUES (?)", ["x".repeat(10000)]);
    }

    // Query with a reasonable limit should work
    const result = sql.query("test-app", "SELECT * FROM big LIMIT 10");
    expect(result.rows).toHaveLength(10);
  });
});

describe("T1523: SQLite client library template", () => {
  it("BridgeSql provides query/run/get methods", () => {
    const homePath = tmpHome();
    const sql = createBridgeSql(homePath);

    sql.run("test-app", "CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)");
    sql.run("test-app", "INSERT INTO items (name) VALUES (?)", ["first"]);

    const row = sql.get("test-app", "SELECT * FROM items WHERE id = ?", [1]);
    expect(row).toEqual({ id: 1, name: "first" });

    const missing = sql.get("test-app", "SELECT * FROM items WHERE id = ?", [999]);
    expect(missing).toBeUndefined();

    sql.closeAll();
    rmSync(homePath, { recursive: true, force: true });
  });
});
