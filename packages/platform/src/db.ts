import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, desc, sql, max } from 'drizzle-orm';
import * as schema from './schema.js';
import { containers, portAssignments } from './schema.js';

export type PlatformDB = ReturnType<typeof createPlatformDb>;

const DB_PATH = process.env.PLATFORM_DB_PATH ?? '/data/platform.db';

let _db: PlatformDB;
let _sqlite: InstanceType<typeof Database>;

export function createPlatformDb(path: string = DB_PATH): PlatformDB {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(path);
  if (path !== ':memory:') {
    sqlite.pragma('journal_mode = WAL');
  }
  const db = drizzle({ client: sqlite, schema });
  runMigrations(sqlite);
  return db;
}

export function getDb(dbPath?: string): PlatformDB {
  if (!_db) {
    _sqlite = new Database(dbPath ?? DB_PATH);
    if ((dbPath ?? DB_PATH) !== ':memory:') {
      _sqlite.pragma('journal_mode = WAL');
    }
    _db = drizzle({ client: _sqlite, schema });
    runMigrations(_sqlite);
  }
  return _db;
}

export function resetDb(): void {
  if (_sqlite) {
    _sqlite.close();
    _sqlite = undefined!;
    _db = undefined!;
  }
}

function runMigrations(sqlite: InstanceType<typeof Database>): void {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS containers (
      handle TEXT PRIMARY KEY,
      clerk_user_id TEXT UNIQUE NOT NULL,
      container_id TEXT,
      port INTEGER NOT NULL,
      shell_port INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'provisioning',
      created_at TEXT NOT NULL,
      last_active TEXT NOT NULL
    )
  `).run();

  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_containers_status ON containers(status)'
  ).run();

  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_containers_clerk ON containers(clerk_user_id)'
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS port_assignments (
      port INTEGER PRIMARY KEY,
      handle TEXT
    )
  `).run();
}

export type ContainerRecord = typeof containers.$inferSelect;
export type NewContainer = typeof containers.$inferInsert;

export function insertContainer(db: PlatformDB, record: Omit<NewContainer, 'createdAt' | 'lastActive'>): void {
  db.insert(containers).values({
    ...record,
    createdAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
  }).run();
}

export function getContainer(db: PlatformDB, handle: string): ContainerRecord | undefined {
  return db.select().from(containers).where(eq(containers.handle, handle)).get();
}

export function getContainerByClerkId(db: PlatformDB, clerkUserId: string): ContainerRecord | undefined {
  return db.select().from(containers).where(eq(containers.clerkUserId, clerkUserId)).get();
}

export function updateContainerStatus(db: PlatformDB, handle: string, status: string, containerId?: string): void {
  const values: Partial<NewContainer> = { status };
  if (containerId !== undefined) {
    values.containerId = containerId;
  }
  db.update(containers).set(values).where(eq(containers.handle, handle)).run();
}

export function updateLastActive(db: PlatformDB, handle: string): void {
  db.update(containers)
    .set({ lastActive: new Date().toISOString() })
    .where(eq(containers.handle, handle))
    .run();
}

export function listContainers(db: PlatformDB, status?: string): ContainerRecord[] {
  if (status) {
    return db.select().from(containers)
      .where(eq(containers.status, status))
      .orderBy(desc(containers.createdAt))
      .all();
  }
  return db.select().from(containers)
    .orderBy(desc(containers.createdAt))
    .all();
}

export function deleteContainer(db: PlatformDB, handle: string): void {
  db.delete(containers).where(eq(containers.handle, handle)).run();
}

export function allocatePort(db: PlatformDB, basePort: number, handle: string): number {
  const existing = db.select({ port: portAssignments.port })
    .from(portAssignments)
    .where(eq(portAssignments.handle, handle))
    .get();
  if (existing) return existing.port;

  const result = db.select({ maxPort: max(portAssignments.port) })
    .from(portAssignments)
    .get();

  const nextPort = result?.maxPort ? result.maxPort + 1 : basePort;

  db.insert(portAssignments).values({ port: nextPort, handle }).run();
  return nextPort;
}

export function releasePort(db: PlatformDB, handle: string): void {
  db.delete(portAssignments).where(eq(portAssignments.handle, handle)).run();
}
