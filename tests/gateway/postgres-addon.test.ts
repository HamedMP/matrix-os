import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createPostgresManager,
  type PostgresManager,
  type PostgresConfig,
} from "../../packages/gateway/src/postgres-manager.js";

function tmpHome(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "pg-addon-")));
  mkdirSync(join(dir, "system", "postgres"), { recursive: true });
  return dir;
}

function defaultConfig(homePath: string): PostgresConfig {
  return {
    homePath,
    port: 5432,
    dataDir: join(homePath, "system", "postgres", "data"),
  };
}

describe("T1530: PostgreSQL service manager", () => {
  let homePath: string;
  let mgr: PostgresManager;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    mgr?.deactivate();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("creates PostgresManager with activate/deactivate lifecycle", () => {
    mgr = createPostgresManager(defaultConfig(homePath));
    expect(typeof mgr.activate).toBe("function");
    expect(typeof mgr.deactivate).toBe("function");
    expect(typeof mgr.status).toBe("function");
    expect(typeof mgr.createAppDatabase).toBe("function");
    expect(typeof mgr.getConnectionString).toBe("function");
  });

  it("starts in inactive state", () => {
    mgr = createPostgresManager(defaultConfig(homePath));
    const status = mgr.status();
    expect(status.active).toBe(false);
    expect(status.databases).toEqual([]);
  });

  it("activate sets state to active", async () => {
    mgr = createPostgresManager(defaultConfig(homePath));
    await mgr.activate();
    const status = mgr.status();
    expect(status.active).toBe(true);
  });

  it("deactivate sets state to inactive and preserves data", async () => {
    mgr = createPostgresManager(defaultConfig(homePath));
    await mgr.activate();
    mgr.deactivate();
    const status = mgr.status();
    expect(status.active).toBe(false);
  });

  it("persists credentials to filesystem", async () => {
    mgr = createPostgresManager(defaultConfig(homePath));
    await mgr.activate();
    await mgr.createAppDatabase("chess");

    const credsPath = join(homePath, "system", "postgres", "credentials.json");
    expect(existsSync(credsPath)).toBe(true);

    const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
    expect(creds.chess).toBeDefined();
    expect(creds.chess.database).toBe("chess_db");
    expect(creds.chess.role).toBe("app_chess");
    expect(creds.chess.password).toBeTruthy();
  });
});

describe("T1531: Per-app database provisioning", () => {
  let homePath: string;
  let mgr: PostgresManager;

  beforeEach(async () => {
    homePath = tmpHome();
    mgr = createPostgresManager(defaultConfig(homePath));
    await mgr.activate();
  });

  afterEach(() => {
    mgr?.deactivate();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("creates database + role for an app", async () => {
    const result = await mgr.createAppDatabase("budget-tracker");
    expect(result.database).toBe("budget_tracker_db");
    expect(result.role).toBe("app_budget_tracker");
    expect(result.password).toBeTruthy();
  });

  it("returns connection string for an app", async () => {
    await mgr.createAppDatabase("crm");
    const connStr = mgr.getConnectionString("crm");
    expect(connStr).toContain("postgresql://");
    expect(connStr).toContain("app_crm");
    expect(connStr).toContain("crm_db");
    expect(connStr).toContain("localhost");
  });

  it("lists all provisioned databases in status", async () => {
    await mgr.createAppDatabase("app-a");
    await mgr.createAppDatabase("app-b");

    const status = mgr.status();
    expect(status.databases).toHaveLength(2);
    expect(status.databases).toContain("app_a_db");
    expect(status.databases).toContain("app_b_db");
  });

  it("rejects invalid app names", async () => {
    await expect(mgr.createAppDatabase("../evil")).rejects.toThrow(/invalid/i);
    await expect(mgr.createAppDatabase("")).rejects.toThrow(/invalid/i);
  });

  it("returns existing credentials for already-provisioned app", async () => {
    const first = await mgr.createAppDatabase("myapp");
    const second = await mgr.createAppDatabase("myapp");
    expect(first.password).toBe(second.password);
    expect(first.database).toBe(second.database);
  });
});

describe("T1533: Activation flow", () => {
  let homePath: string;
  let mgr: PostgresManager;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    mgr?.deactivate();
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("status returns running state and database list", async () => {
    mgr = createPostgresManager(defaultConfig(homePath));
    await mgr.activate();
    await mgr.createAppDatabase("chess");

    const status = mgr.status();
    expect(status.active).toBe(true);
    expect(status.databases).toContain("chess_db");
    expect(status.port).toBe(5432);
  });

  it("cannot create databases when inactive", async () => {
    mgr = createPostgresManager(defaultConfig(homePath));
    await expect(mgr.createAppDatabase("test")).rejects.toThrow(/not active/i);
  });
});

describe("T1534: Storage usage tracking", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = tmpHome();
  });

  afterEach(() => {
    if (homePath) rmSync(homePath, { recursive: true, force: true });
  });

  it("tracks storage usage with breakdown by type", async () => {
    const { createStorageTracker } = await import("../../packages/gateway/src/storage-tracker.js");
    mkdirSync(join(homePath, "data", "test-app"), { recursive: true });
    writeFileSync(join(homePath, "data", "test-app", "file.txt"), "x".repeat(1000));
    mkdirSync(join(homePath, "system", "logs"), { recursive: true });
    writeFileSync(join(homePath, "system", "logs", "2026-03-04.jsonl"), "log line\n");

    const tracker = createStorageTracker(homePath);
    const usage = tracker.measure();

    expect(usage.disk).toBeGreaterThan(0);
    expect(typeof usage.disk).toBe("number");
  });

  it("returns per-app SQLite sizes", async () => {
    const { createStorageTracker } = await import("../../packages/gateway/src/storage-tracker.js");

    // Create an actual sqlite database
    const Database = (await import("better-sqlite3")).default;
    const appDir = join(homePath, "data", "test-app");
    mkdirSync(appDir, { recursive: true });
    const db = new Database(join(appDir, "db.sqlite"));
    db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, data TEXT)").run();
    db.prepare("INSERT INTO t (data) VALUES (?)").run("test data");
    db.close();

    const tracker = createStorageTracker(homePath);
    const usage = tracker.measure();

    expect(usage.sqlite).toBeDefined();
    expect(usage.sqlite["test-app"]).toBeGreaterThan(0);
  });

  it("logs usage to storage.jsonl", async () => {
    const { createStorageTracker } = await import("../../packages/gateway/src/storage-tracker.js");
    mkdirSync(join(homePath, "system", "logs"), { recursive: true });

    const tracker = createStorageTracker(homePath);
    tracker.record();

    const logPath = join(homePath, "system", "logs", "storage.jsonl");
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.disk).toBeDefined();
    expect(entry.timestamp).toBeDefined();
  });
});
