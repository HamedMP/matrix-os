import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { eq, desc, sql, max, and, isNull, inArray, lt } from 'drizzle-orm';
import * as schema from './schema.js';
import { containers, portAssignments, userMachines } from './schema.js';
import { runAppRegistryMigrations } from './app-registry.js';
import { runMatrixUserMigrations } from './matrix-provisioning.js';
import { runSocialFeedMigrations } from './social-feed.js';

export type PlatformDB = ReturnType<typeof createPlatformDb>;

const DB_PATH = process.env.PLATFORM_DB_PATH ?? '/data/platform.db';

let _db: PlatformDB;
let _sqlite: InstanceType<typeof Database>;

export function createPlatformDb(path: string = DB_PATH) {
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

type BetterSqliteClient = InstanceType<typeof Database>;

function sqliteClient(db: PlatformDB): BetterSqliteClient {
  return (db as { $client: BetterSqliteClient }).$client;
}

export function runInPlatformTransaction<T>(
  db: PlatformDB,
  fn: () => T,
): T {
  return sqliteClient(db).transaction(fn)();
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
    CREATE TABLE IF NOT EXISTS user_machines (
      machine_id TEXT PRIMARY KEY,
      clerk_user_id TEXT UNIQUE NOT NULL,
      handle TEXT NOT NULL,
      hetzner_server_id INTEGER,
      public_ipv4 TEXT,
      public_ipv6 TEXT,
      status TEXT NOT NULL DEFAULT 'provisioning',
      image_version TEXT,
      registration_token_hash TEXT,
      registration_token_expires_at TEXT,
      provisioned_at TEXT NOT NULL,
      last_seen_at TEXT,
      deleted_at TEXT,
      failure_code TEXT,
      failure_at TEXT
    )
  `).run();
  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_user_machines_status ON user_machines(status)'
  ).run();
  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_user_machines_clerk ON user_machines(clerk_user_id)'
  ).run();
  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_user_machines_hetzner ON user_machines(hetzner_server_id)'
  ).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS port_assignments (
      port INTEGER PRIMARY KEY,
      handle TEXT
    )
  `).run();

  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS device_codes (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      clerk_user_id TEXT,
      expires_at INTEGER NOT NULL,
      last_polled_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `).run();
  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code)'
  ).run();
  sqlite.prepare(
    'CREATE INDEX IF NOT EXISTS idx_device_codes_expires_at ON device_codes(expires_at)'
  ).run();

  runAppRegistryMigrations(sqlite);
  runMatrixUserMigrations(sqlite);
  runSocialFeedMigrations(sqlite);
}

export type ContainerRecord = typeof containers.$inferSelect;
export type NewContainer = typeof containers.$inferInsert;
export type UserMachineRecord = typeof userMachines.$inferSelect;
export type NewUserMachine = typeof userMachines.$inferInsert;

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

export function insertUserMachine(db: PlatformDB, record: NewUserMachine): void {
  db.insert(userMachines).values(record).run();
}

export function getUserMachine(db: PlatformDB, machineId: string): UserMachineRecord | undefined {
  return db.select().from(userMachines).where(eq(userMachines.machineId, machineId)).get();
}

export function getActiveUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): UserMachineRecord | undefined {
  return db.select()
    .from(userMachines)
    .where(and(eq(userMachines.clerkUserId, clerkUserId), isNull(userMachines.deletedAt)))
    .get();
}

export function getActiveUserMachineByHandle(
  db: PlatformDB,
  handle: string,
): UserMachineRecord | undefined {
  return db.select()
    .from(userMachines)
    .where(and(eq(userMachines.handle, handle), isNull(userMachines.deletedAt)))
    .get();
}

export function updateUserMachine(
  db: PlatformDB,
  machineId: string,
  values: Partial<NewUserMachine>,
): void {
  db.update(userMachines).set(values).where(eq(userMachines.machineId, machineId)).run();
}

export function softDeleteUserMachine(db: PlatformDB, machineId: string, deletedAt: string): void {
  db.update(userMachines)
    .set({ status: 'deleted', deletedAt })
    .where(eq(userMachines.machineId, machineId))
    .run();
}

export function listStaleUserMachines(
  db: PlatformDB,
  statuses: string[],
  olderThanIso: string,
  limit: number,
): UserMachineRecord[] {
  return db.select()
    .from(userMachines)
    .where(and(inArray(userMachines.status, statuses), lt(userMachines.provisionedAt, olderThanIso), isNull(userMachines.deletedAt)))
    .orderBy(userMachines.provisionedAt)
    .limit(limit)
    .all();
}

export function allocatePort(db: PlatformDB, basePort: number, handle: string): number {
  return runInPlatformTransaction(db, () => {
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
  });
}

export function releasePort(db: PlatformDB, handle: string): void {
  db.delete(portAssignments).where(eq(portAssignments.handle, handle)).run();
}
