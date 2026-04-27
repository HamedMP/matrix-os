import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

const DEFAULT_PLATFORM_DB_URL =
  process.env.PLATFORM_DATABASE_URL ??
  (process.env.POSTGRES_URL ? `${process.env.POSTGRES_URL}/matrixos_platform` : undefined);

type Executor = Kysely<PlatformDatabase> | Transaction<PlatformDatabase>;

interface ContainersTable {
  handle: string;
  clerk_user_id: string;
  container_id: string | null;
  port: number;
  shell_port: number;
  status: string;
  created_at: string;
  last_active: string;
}

interface UserMachinesTable {
  machine_id: string;
  clerk_user_id: string;
  handle: string;
  hetzner_server_id: number | null;
  public_ipv4: string | null;
  public_ipv6: string | null;
  status: string;
  image_version: string | null;
  registration_token_hash: string | null;
  registration_token_expires_at: string | null;
  provisioned_at: string;
  last_seen_at: string | null;
  deleted_at: string | null;
  failure_code: string | null;
  failure_at: string | null;
}

interface PortAssignmentsTable {
  port: number;
  handle: string | null;
}

interface DeviceCodesTable {
  device_code: string;
  user_code: string;
  clerk_user_id: string | null;
  expires_at: number;
  last_polled_at: number | null;
  created_at: number;
}

interface MatrixUsersTable {
  handle: string;
  human_matrix_id: string;
  ai_matrix_id: string;
  human_access_token: string;
  ai_access_token: string;
  created_at: string;
}

interface AppsRegistryTable {
  id: string;
  name: string;
  slug: string;
  author_id: string;
  description: string | null;
  category: string | null;
  tags: string | null;
  version: string | null;
  source_url: string | null;
  manifest: string | null;
  screenshots: string | null;
  installs: number;
  rating: number;
  ratings_count: number;
  forks_count: number;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

interface AppRatingsTable {
  app_id: string;
  user_id: string;
  rating: number;
  review: string | null;
  created_at: string;
}

interface AppInstallsTable {
  app_id: string;
  user_id: string;
  installed_at: string;
}

interface SocialPostsTable {
  id: string;
  author_id: string;
  content: string;
  type: string;
  media_urls: string | null;
  app_ref: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
}

interface SocialCommentsTable {
  id: string;
  post_id: string;
  author_id: string;
  content: string;
  created_at: string;
}

interface SocialLikesTable {
  post_id: string;
  user_id: string;
  created_at: string;
}

interface SocialFollowsTable {
  follower_id: string;
  following_id: string;
  following_type: string;
  created_at: string;
}

export interface PlatformDatabase {
  containers: ContainersTable;
  user_machines: UserMachinesTable;
  port_assignments: PortAssignmentsTable;
  device_codes: DeviceCodesTable;
  matrix_users: MatrixUsersTable;
  apps_registry: AppsRegistryTable;
  app_ratings: AppRatingsTable;
  app_installs: AppInstallsTable;
  social_posts: SocialPostsTable;
  social_comments: SocialCommentsTable;
  social_likes: SocialLikesTable;
  social_follows: SocialFollowsTable;
}

export interface PlatformDB {
  kysely: Kysely<PlatformDatabase>;
  executor: Executor;
  ready: Promise<void>;
  transaction<T>(fn: (trx: PlatformDB) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

export interface ContainerRecord {
  handle: string;
  clerkUserId: string;
  containerId: string | null;
  port: number;
  shellPort: number;
  status: string;
  createdAt: string;
  lastActive: string;
}

export interface NewContainer {
  handle: string;
  clerkUserId: string;
  containerId: string | null;
  port: number;
  shellPort: number;
  status: string;
  createdAt?: string;
  lastActive?: string;
}

export interface UserMachineRecord {
  machineId: string;
  clerkUserId: string;
  handle: string;
  hetznerServerId: number | null;
  publicIPv4: string | null;
  publicIPv6: string | null;
  status: string;
  imageVersion: string | null;
  registrationTokenHash: string | null;
  registrationTokenExpiresAt: string | null;
  provisionedAt: string;
  lastSeenAt: string | null;
  deletedAt: string | null;
  failureCode: string | null;
  failureAt: string | null;
}

export interface NewUserMachine {
  machineId: string;
  clerkUserId: string;
  handle: string;
  hetznerServerId?: number | null;
  publicIPv4?: string | null;
  publicIPv6?: string | null;
  status: string;
  imageVersion?: string | null;
  registrationTokenHash?: string | null;
  registrationTokenExpiresAt?: string | null;
  provisionedAt: string;
  lastSeenAt?: string | null;
  deletedAt?: string | null;
  failureCode?: string | null;
  failureAt?: string | null;
}

function wrapDb(
  kysely: Kysely<PlatformDatabase>,
  executor: Executor,
  ready: Promise<void>,
  destroyFn: () => Promise<void>,
): PlatformDB {
  return {
    kysely,
    executor,
    ready,
    async transaction(fn) {
      await ready;
      return kysely.transaction().execute((trx) =>
        fn(wrapDb(kysely, trx, Promise.resolve(), destroyFn)),
      );
    },
    destroy: destroyFn,
  };
}

async function migrate(db: Kysely<PlatformDatabase>): Promise<void> {
  await sql`
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
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_containers_status ON containers(status)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_containers_clerk ON containers(clerk_user_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS user_machines (
      machine_id TEXT PRIMARY KEY,
      clerk_user_id TEXT NOT NULL,
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
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_status ON user_machines(status)`.execute(db);
  await sql`ALTER TABLE user_machines DROP CONSTRAINT IF EXISTS user_machines_clerk_user_id_key`.execute(db);
  await sql`DROP INDEX IF EXISTS idx_user_machines_clerk`.execute(db);
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_user_machines_clerk_active
    ON user_machines(clerk_user_id)
    WHERE deleted_at IS NULL
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_user_machines_hetzner ON user_machines(hetzner_server_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS port_assignments (
      port INTEGER PRIMARY KEY,
      handle TEXT UNIQUE
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS device_codes (
      device_code TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      clerk_user_id TEXT,
      expires_at BIGINT NOT NULL,
      last_polled_at BIGINT,
      created_at BIGINT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_device_codes_expires_at ON device_codes(expires_at)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS matrix_users (
      handle TEXT PRIMARY KEY,
      human_matrix_id TEXT NOT NULL,
      ai_matrix_id TEXT NOT NULL,
      human_access_token TEXT NOT NULL,
      ai_access_token TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_matrix_human_id ON matrix_users(human_matrix_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_matrix_ai_id ON matrix_users(ai_matrix_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS apps_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      author_id TEXT NOT NULL,
      description TEXT,
      category TEXT DEFAULT 'utility',
      tags TEXT,
      version TEXT DEFAULT '1.0.0',
      source_url TEXT,
      manifest TEXT,
      screenshots TEXT,
      installs INTEGER NOT NULL DEFAULT 0,
      rating INTEGER NOT NULL DEFAULT 0,
      ratings_count INTEGER NOT NULL DEFAULT 0,
      forks_count INTEGER NOT NULL DEFAULT 0,
      is_public BOOLEAN NOT NULL DEFAULT false,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(author_id, slug)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_category ON apps_registry(category)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_public ON apps_registry(is_public)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_apps_installs ON apps_registry(installs)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS app_ratings (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(app_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS app_installs (
      app_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      UNIQUE(app_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL,
      media_urls TEXT,
      app_ref TEXT,
      likes_count INTEGER NOT NULL DEFAULT 0,
      comments_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_author ON social_posts(author_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_type ON social_posts(type)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_created ON social_posts(created_at)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_posts_likes ON social_posts(likes_count)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_comments_post ON social_comments(post_id)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(post_id, user_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS social_follows (
      follower_id TEXT NOT NULL,
      following_id TEXT NOT NULL,
      following_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(follower_id, following_id)
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_follower ON social_follows(follower_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_follows_following ON social_follows(following_id)`.execute(db);
}

export function createPlatformDb(opts: string | { dialect: unknown } = DEFAULT_PLATFORM_DB_URL ?? ''): PlatformDB {
  if (typeof opts === 'string' && !opts) {
    throw new Error('Platform Postgres URL is required: set PLATFORM_DATABASE_URL or POSTGRES_URL');
  }

  let pool: pg.Pool | null = null;
  const kysely = typeof opts === 'string'
    ? (() => {
        pool = new pg.Pool({ connectionString: opts, max: 10 });
        pool.on('error', (err) => {
          console.error('[platform-db] Idle pool client error:', err.message);
        });
        return new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
      })()
    : new Kysely<PlatformDatabase>({ dialect: opts.dialect as never });

  const ready = migrate(kysely);
  return wrapDb(kysely, kysely, ready, async () => {
    await kysely.destroy();
    await pool?.end();
  });
}

let singleton: PlatformDB | undefined;

export function getDb(dbUrl?: string): PlatformDB {
  if (!singleton) {
    singleton = createPlatformDb(dbUrl ?? DEFAULT_PLATFORM_DB_URL);
  }
  return singleton;
}

export async function resetDb(): Promise<void> {
  if (singleton) {
    await singleton.destroy();
    singleton = undefined;
  }
}

export async function runInPlatformTransaction<T>(
  db: PlatformDB,
  fn: (trx: PlatformDB) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}

function mapContainer(row: ContainersTable): ContainerRecord {
  return {
    handle: row.handle,
    clerkUserId: row.clerk_user_id,
    containerId: row.container_id,
    port: row.port,
    shellPort: row.shell_port,
    status: row.status,
    createdAt: row.created_at,
    lastActive: row.last_active,
  };
}

function toContainerRow(record: NewContainer): ContainersTable {
  const now = new Date().toISOString();
  return {
    handle: record.handle,
    clerk_user_id: record.clerkUserId,
    container_id: record.containerId,
    port: record.port,
    shell_port: record.shellPort,
    status: record.status,
    created_at: record.createdAt ?? now,
    last_active: record.lastActive ?? now,
  };
}

function mapUserMachine(row: UserMachinesTable): UserMachineRecord {
  return {
    machineId: row.machine_id,
    clerkUserId: row.clerk_user_id,
    handle: row.handle,
    hetznerServerId: row.hetzner_server_id,
    publicIPv4: row.public_ipv4,
    publicIPv6: row.public_ipv6,
    status: row.status,
    imageVersion: row.image_version,
    registrationTokenHash: row.registration_token_hash,
    registrationTokenExpiresAt: row.registration_token_expires_at,
    provisionedAt: row.provisioned_at,
    lastSeenAt: row.last_seen_at,
    deletedAt: row.deleted_at,
    failureCode: row.failure_code,
    failureAt: row.failure_at,
  };
}

function toUserMachineRow(record: NewUserMachine): UserMachinesTable {
  return {
    machine_id: record.machineId,
    clerk_user_id: record.clerkUserId,
    handle: record.handle,
    hetzner_server_id: record.hetznerServerId ?? null,
    public_ipv4: record.publicIPv4 ?? null,
    public_ipv6: record.publicIPv6 ?? null,
    status: record.status,
    image_version: record.imageVersion ?? null,
    registration_token_hash: record.registrationTokenHash ?? null,
    registration_token_expires_at: record.registrationTokenExpiresAt ?? null,
    provisioned_at: record.provisionedAt,
    last_seen_at: record.lastSeenAt ?? null,
    deleted_at: record.deletedAt ?? null,
    failure_code: record.failureCode ?? null,
    failure_at: record.failureAt ?? null,
  };
}

function toUserMachineUpdate(values: Partial<NewUserMachine>): Partial<UserMachinesTable> {
  const update: Partial<UserMachinesTable> = {};
  if (values.machineId !== undefined) update.machine_id = values.machineId;
  if (values.clerkUserId !== undefined) update.clerk_user_id = values.clerkUserId;
  if (values.handle !== undefined) update.handle = values.handle;
  if (values.hetznerServerId !== undefined) update.hetzner_server_id = values.hetznerServerId;
  if (values.publicIPv4 !== undefined) update.public_ipv4 = values.publicIPv4;
  if (values.publicIPv6 !== undefined) update.public_ipv6 = values.publicIPv6;
  if (values.status !== undefined) update.status = values.status;
  if (values.imageVersion !== undefined) update.image_version = values.imageVersion;
  if (values.registrationTokenHash !== undefined) update.registration_token_hash = values.registrationTokenHash;
  if (values.registrationTokenExpiresAt !== undefined) update.registration_token_expires_at = values.registrationTokenExpiresAt;
  if (values.provisionedAt !== undefined) update.provisioned_at = values.provisionedAt;
  if (values.lastSeenAt !== undefined) update.last_seen_at = values.lastSeenAt;
  if (values.deletedAt !== undefined) update.deleted_at = values.deletedAt;
  if (values.failureCode !== undefined) update.failure_code = values.failureCode;
  if (values.failureAt !== undefined) update.failure_at = values.failureAt;
  return update;
}

export async function insertContainer(db: PlatformDB, record: NewContainer): Promise<void> {
  await db.ready;
  await db.executor.insertInto('containers').values(toContainerRow(record)).execute();
}

export async function getContainer(db: PlatformDB, handle: string): Promise<ContainerRecord | undefined> {
  await db.ready;
  const row = await db.executor.selectFrom('containers').selectAll().where('handle', '=', handle).executeTakeFirst();
  return row ? mapContainer(row) : undefined;
}

export async function getContainerByClerkId(db: PlatformDB, clerkUserId: string): Promise<ContainerRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('containers')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  return row ? mapContainer(row) : undefined;
}

export async function updateContainerStatus(
  db: PlatformDB,
  handle: string,
  status: string,
  containerId?: string,
): Promise<void> {
  await db.ready;
  const values: Partial<ContainersTable> = { status };
  if (containerId !== undefined) values.container_id = containerId;
  await db.executor.updateTable('containers').set(values).where('handle', '=', handle).execute();
}

export async function updateLastActive(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('containers')
    .set({ last_active: new Date().toISOString() })
    .where('handle', '=', handle)
    .execute();
}

export async function listContainers(db: PlatformDB, status?: string): Promise<ContainerRecord[]> {
  await db.ready;
  let query = db.executor.selectFrom('containers').selectAll();
  if (status) query = query.where('status', '=', status);
  const rows = await query.orderBy('created_at', 'desc').execute();
  return rows.map(mapContainer);
}

export async function deleteContainer(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor.deleteFrom('containers').where('handle', '=', handle).execute();
}

export async function insertUserMachine(db: PlatformDB, record: NewUserMachine): Promise<void> {
  await db.ready;
  await db.executor.insertInto('user_machines').values(toUserMachineRow(record)).execute();
}

export async function getUserMachine(db: PlatformDB, machineId: string): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('machine_id', '=', machineId)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getActiveUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getActiveUserMachineByHandle(
  db: PlatformDB,
  handle: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByHandle(
  db: PlatformDB,
  handle: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('handle', '=', handle)
    .where('status', '=', 'running')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function getRunningUserMachineByClerkId(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('clerk_user_id', '=', clerkUserId)
    .where('status', '=', 'running')
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function updateUserMachine(
  db: PlatformDB,
  machineId: string,
  values: Partial<NewUserMachine>,
): Promise<void> {
  await db.ready;
  await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .execute();
}

export async function completeUserMachineRegistration(
  db: PlatformDB,
  machineId: string,
  hetznerServerId: number,
  expectedRegistrationTokenHash: string,
  expiresAfterIso: string,
  values: Partial<NewUserMachine>,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set(toUserMachineUpdate(values))
    .where('machine_id', '=', machineId)
    .where('hetzner_server_id', '=', hetznerServerId)
    .where('registration_token_hash', '=', expectedRegistrationTokenHash)
    .where('registration_token_expires_at', '>=', expiresAfterIso)
    .where('status', 'in', ['provisioning', 'recovering'])
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimUserMachineRecovery(
  db: PlatformDB,
  clerkUserId: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({
      status: 'recovering',
      failure_code: null,
      failure_at: null,
    })
    .where('clerk_user_id', '=', clerkUserId)
    .where('deleted_at', 'is', null)
    .where('status', '!=', 'recovering')
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function claimUserMachineDelete(
  db: PlatformDB,
  machineId: string,
  deletedAt: string,
): Promise<UserMachineRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .updateTable('user_machines')
    .set({ status: 'deleted', deleted_at: deletedAt })
    .where('machine_id', '=', machineId)
    .where('deleted_at', 'is', null)
    .returningAll()
    .executeTakeFirst();
  return row ? mapUserMachine(row) : undefined;
}

export async function softDeleteUserMachine(db: PlatformDB, machineId: string, deletedAt: string): Promise<void> {
  await claimUserMachineDelete(db, machineId, deletedAt);
}

export async function listStaleUserMachines(
  db: PlatformDB,
  statuses: string[],
  olderThanIso: string,
  limit: number,
): Promise<UserMachineRecord[]> {
  await db.ready;
  if (statuses.length === 0) return [];
  const rows = await db.executor
    .selectFrom('user_machines')
    .selectAll()
    .where('status', 'in', statuses)
    .where('provisioned_at', '<', olderThanIso)
    .where('deleted_at', 'is', null)
    .orderBy('provisioned_at')
    .limit(limit)
    .execute();
  return rows.map(mapUserMachine);
}

export async function allocatePort(db: PlatformDB, basePort: number, handle: string): Promise<number> {
  await db.ready;
  for (let attempt = 0; attempt < 32; attempt++) {
    const existing = await db.executor
      .selectFrom('port_assignments')
      .select('port')
      .where('handle', '=', handle)
      .executeTakeFirst();
    if (existing) return existing.port;

    const result = await db.executor
      .selectFrom('port_assignments')
      .select((eb) => eb.fn.max<number>('port').as('max_port'))
      .executeTakeFirst();
    const nextPort = result?.max_port ? Number(result.max_port) + 1 : basePort;
    const inserted = await db.executor
      .insertInto('port_assignments')
      .values({ port: nextPort, handle })
      .onConflict((oc) => oc.doNothing())
      .returning('port')
      .executeTakeFirst();
    if (inserted) return inserted.port;
  }
  throw new Error('Unable to allocate platform port after concurrent retries');
}

export async function releasePort(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor.deleteFrom('port_assignments').where('handle', '=', handle).execute();
}
