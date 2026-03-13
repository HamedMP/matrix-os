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

  // Embeddings table (vector store for semantic search)
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_id TEXT,
      vector TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    "CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_type, source_id)",
  ).run();

  // Social tables
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      media_urls TEXT,
      app_ref TEXT,
      parent_id TEXT,
      likes_count INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_posts_author ON social_posts(author_id)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_posts_type ON social_posts(type)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_posts_created ON social_posts(created_at)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_posts_likes ON social_posts(likes_count)").run();
  sqlite.prepare("CREATE INDEX IF NOT EXISTS idx_posts_parent ON social_posts(parent_id)").run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS social_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_likes_post_user ON social_likes(post_id, user_id)",
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS social_follows (
      follower_id TEXT NOT NULL,
      followee_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_follows_pair ON social_follows(follower_id, followee_id)",
  ).run();
  sqlite.prepare(
    "CREATE INDEX IF NOT EXISTS idx_follows_follower ON social_follows(follower_id)",
  ).run();
  sqlite.prepare(
    "CREATE INDEX IF NOT EXISTS idx_follows_followee ON social_follows(followee_id)",
  ).run();
}
