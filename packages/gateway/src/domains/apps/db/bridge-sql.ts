import { existsSync, mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import Database from "better-sqlite3";

export interface QueryResult {
  rows: Record<string, unknown>[];
}

export interface ExecResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface BridgeSql {
  query(appName: string, sql: string, params?: unknown[]): QueryResult;
  run(appName: string, sql: string, params?: unknown[]): ExecResult;
  get(appName: string, sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  closeAll(): void;
}

const SAFE_APP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const FORBIDDEN_SQL_PATTERNS = [
  /\bATTACH\s+DATABASE\b/i,
  /\bDETACH\s+DATABASE\b/i,
];

const SAFE_PRAGMAS = [
  "table_info",
  "table_list",
  "index_list",
  "index_info",
  "foreign_key_list",
  "database_list",
  "table_xinfo",
  "compile_options",
];

function validateAppName(appName: string): void {
  if (!SAFE_APP_NAME.test(appName)) {
    throw new Error(`Invalid app name: ${appName}`);
  }
  if (appName.includes("..") || appName.includes("/") || appName.includes("\\")) {
    throw new Error(`Invalid app name: ${appName}`);
  }
}

function validateSql(sql: string): void {
  for (const pattern of FORBIDDEN_SQL_PATTERNS) {
    if (pattern.test(sql)) {
      throw new Error(`Forbidden SQL operation: ${sql.slice(0, 50)}`);
    }
  }

  const trimmed = sql.trim().toUpperCase();
  if (trimmed.startsWith("PRAGMA")) {
    const pragmaMatch = sql.match(/PRAGMA\s+(\w+)/i);
    if (pragmaMatch) {
      const pragmaName = pragmaMatch[1].toLowerCase();
      if (SAFE_PRAGMAS.includes(pragmaName)) {
        return;
      }
    }
    throw new Error(`Forbidden PRAGMA operation: ${sql.slice(0, 50)}`);
  }
}

/** @deprecated Use AppDb query engine (app-db-query.ts) instead. Per-app SQLite will be removed in v0.6.0. */
export function createBridgeSql(homePath: string): BridgeSql {
  const databases = new Map<string, Database.Database>();

  function getDb(appName: string): Database.Database {
    validateAppName(appName);

    let db = databases.get(appName);
    if (db) return db;

    const dataDir = join(homePath, "data", appName);
    const dbPath = normalize(join(dataDir, "db.sqlite"));

    if (!dbPath.startsWith(normalize(join(homePath, "data", appName)))) {
      throw new Error(`Invalid app name: ${appName}`);
    }

    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    databases.set(appName, db);
    return db;
  }

  return {
    query(appName: string, sql: string, params?: unknown[]): QueryResult {
      validateSql(sql);
      const db = getDb(appName);
      const stmt = db.prepare(sql);
      const rows = params ? stmt.all(...params) : stmt.all();
      return { rows: rows as Record<string, unknown>[] };
    },

    run(appName: string, sql: string, params?: unknown[]): ExecResult {
      validateSql(sql);
      const db = getDb(appName);
      const stmt = db.prepare(sql);
      const result = params ? stmt.run(...params) : stmt.run();
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },

    get(appName: string, sql: string, params?: unknown[]): Record<string, unknown> | undefined {
      validateSql(sql);
      const db = getDb(appName);
      const stmt = db.prepare(sql);
      const row = params ? stmt.get(...params) : stmt.get();
      return row as Record<string, unknown> | undefined;
    },

    closeAll(): void {
      for (const db of databases.values()) {
        db.close();
      }
      databases.clear();
    },
  };
}
