/**
 * Container + platform-user persistence.
 *
 * Extracted from ../db.ts (Phase 1-A2). Pure move: no logic changes.
 */
import { randomUUID } from 'node:crypto';
import { type InsertObject, sql } from 'kysely';
import type {
  ContainersTable,
  PlatformDatabase,
  PlatformDB,
  UsersTable,
} from './schema-tables.js';
import type {
  ContainerRecord,
  NewContainer,
  NewPlatformUser,
  PlatformHandleConflict,
  PlatformUserRecord,
} from './schema-records.js';

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

function mapPlatformUser(row: UsersTable): PlatformUserRecord {
  return {
    id: row.id,
    clerkId: row.clerk_id,
    handle: row.handle,
    displayName: row.display_name,
    email: row.email,
    containerId: row.container_id,
    containerVersion: row.container_version,
    plan: row.plan,
    status: row.status,
    pipedreamExternalId: row.pipedream_external_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPlatformUserRow(record: NewPlatformUser): InsertObject<PlatformDatabase, 'users'> {
  return {
    id: randomUUID(),
    clerk_id: record.clerkId,
    handle: record.handle,
    display_name: record.displayName,
    email: record.email,
    container_id: record.containerId,
    container_version: record.containerVersion ?? null,
    plan: record.plan ?? 'free',
    status: record.status ?? 'active',
    pipedream_external_id: record.pipedreamExternalId ?? null,
    created_at: sql`now()`,
    updated_at: sql`now()`,
  };
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
  const rows = await query
    .orderBy('created_at', 'desc')
    .orderBy('handle', 'desc')
    .execute();
  return rows.map(mapContainer);
}

export async function deleteContainer(db: PlatformDB, handle: string): Promise<void> {
  await db.ready;
  await db.executor.deleteFrom('containers').where('handle', '=', handle).execute();
}

export async function ensurePlatformUser(
  db: PlatformDB,
  record: NewPlatformUser,
): Promise<PlatformUserRecord> {
  await db.ready;
  const row = await db.executor
    .insertInto('users')
    .values(toPlatformUserRow(record))
    .onConflict((oc) => oc.column('clerk_id').doUpdateSet({
      handle: sql`users.handle`,
      display_name: record.displayName,
      email: record.email,
      container_id: sql`
        CASE
          WHEN users.container_id LIKE 'clerk:%' AND EXCLUDED.container_id NOT LIKE 'clerk:%'
            THEN EXCLUDED.container_id
          WHEN EXCLUDED.container_id LIKE 'clerk:%' AND users.container_id NOT LIKE 'clerk:%'
            THEN users.container_id
          ELSE EXCLUDED.container_id
        END
      `,
      container_version: sql`COALESCE(EXCLUDED.container_version, users.container_version)`,
      plan: record.plan ?? 'free',
      status: record.status ?? 'active',
      pipedream_external_id: sql`COALESCE(users.pipedream_external_id, EXCLUDED.pipedream_external_id)`,
      updated_at: sql`now()`,
    }))
    .returningAll()
    .executeTakeFirstOrThrow();
  return mapPlatformUser(row);
}

export async function getPlatformHandleConflict(
  db: PlatformDB,
  handle: string,
  clerkUserId: string,
): Promise<PlatformHandleConflict | undefined> {
  await db.ready;
  const platformUser = await db.executor
    .selectFrom('users')
    .select('clerk_id')
    .where('handle', '=', handle)
    .where('clerk_id', '!=', clerkUserId)
    .executeTakeFirst();
  if (platformUser) {
    return { source: 'users', clerkUserId: platformUser.clerk_id };
  }

  const activeMachine = await db.executor
    .selectFrom('user_machines')
    .select('clerk_user_id')
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null)
    .where('clerk_user_id', '!=', clerkUserId)
    .executeTakeFirst();
  if (activeMachine) {
    return { source: 'user_machines', clerkUserId: activeMachine.clerk_user_id };
  }

  const ownedActiveMachine = await db.executor
    .selectFrom('user_machines')
    .select('machine_id')
    .where('handle', '=', handle)
    .where('deleted_at', 'is', null)
    .where('clerk_user_id', '=', clerkUserId)
    .executeTakeFirst();
  if (ownedActiveMachine) {
    return undefined;
  }

  const legacyContainer = await db.executor
    .selectFrom('containers')
    .select('clerk_user_id')
    .where('handle', '=', handle)
    .where('clerk_user_id', '!=', clerkUserId)
    .executeTakeFirst();
  if (legacyContainer) {
    return { source: 'containers', clerkUserId: legacyContainer.clerk_user_id };
  }

  return undefined;
}

export async function isPlatformHandleAvailableForClerkUser(
  db: PlatformDB,
  handle: string,
  clerkUserId: string,
): Promise<boolean> {
  return !(await getPlatformHandleConflict(db, handle, clerkUserId));
}

export async function getPlatformUserByClerkId(
  db: PlatformDB,
  clerkId: string,
): Promise<PlatformUserRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('users')
    .selectAll()
    .where('clerk_id', '=', clerkId)
    .executeTakeFirst();
  return row ? mapPlatformUser(row) : undefined;
}

export async function getPlatformUserByHandle(
  db: PlatformDB,
  handle: string,
): Promise<PlatformUserRecord | undefined> {
  await db.ready;
  const row = await db.executor
    .selectFrom('users')
    .selectAll()
    .where('handle', '=', handle)
    .executeTakeFirst();
  return row ? mapPlatformUser(row) : undefined;
}

export async function listActivePlatformUsersByNormalizedHandle(
  db: PlatformDB,
  normalizedHandle: string,
): Promise<PlatformUserRecord[]> {
  await db.ready;
  const rows = await db.executor
    .selectFrom('users')
    .selectAll()
    .where('handle', '=', normalizedHandle)
    .where('status', '=', 'active')
    .limit(2)
    .execute();
  return rows.map(mapPlatformUser);
}
