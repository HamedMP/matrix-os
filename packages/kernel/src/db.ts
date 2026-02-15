import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema.js";

export type MatrixDB = ReturnType<typeof createDB>;

export function createDB(path: string = ":memory:") {
  const sqlite = new Database(path);

  if (path !== ":memory:") {
    sqlite.pragma("journal_mode = WAL");
  }

  const db = drizzle({ client: sqlite, schema });

  runMigrations(sqlite);

  return db;
}

function runMigrations(sqlite: InstanceType<typeof Database>) {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      assigned_to TEXT,
      depends_on TEXT,
      input TEXT NOT NULL,
      output TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      completed_at INTEGER
    )
  `).run();

  sqlite.prepare(
    `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  ).run();

  sqlite.prepare(
    `CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to)`,
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      content TEXT NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )
  `).run();

  sqlite.prepare(
    `CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, read)`,
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT,
      category TEXT DEFAULT 'fact',
      created_at TEXT,
      updated_at TEXT
    )
  `).run();

  sqlite.prepare(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
    USING fts5(content, content_rowid='rowid')
  `).run();
}
