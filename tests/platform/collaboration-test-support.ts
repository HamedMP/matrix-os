import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool, type PoolConfig } from "pg";
import type { CollaborationPlatformDatabase } from "../../packages/platform/src/collaboration/database.js";
import { createTestPlatformDb, destroyTestPlatformDb, type TestPlatformDb } from "./platform-db-test-helper.js";

export const platformCollaborationActors = {
  owner: "user_platform_owner",
  recipientWithoutComputer: "user_platform_recipient",
  outsider: "user_platform_outsider",
} as const;

export interface PlatformCollaborationTestDatabase extends TestPlatformDb {
  collaborationDb: Kysely<CollaborationPlatformDatabase>;
}

export interface RealPlatformCollaborationTestDatabase {
  collaborationDb: Kysely<CollaborationPlatformDatabase>;
  destroy(): Promise<void>;
}

export interface RealPlatformCollaborationTestDatabaseDependencies {
  createPool(config: PoolConfig): Pool;
  createAdminDatabase(pool: Pool): Kysely<Record<string, never>>;
  createCollaborationDatabase(pool: Pool): Kysely<CollaborationPlatformDatabase>;
  createSchema(adminDb: Kysely<Record<string, never>>, schema: string): Promise<void>;
  dropSchema(adminDb: Kysely<Record<string, never>>, schema: string): Promise<void>;
  logCleanupError(resource: string, error: unknown): void;
}

const defaultRealDatabaseDependencies: RealPlatformCollaborationTestDatabaseDependencies = {
  createPool: (config) => new Pool(config),
  createAdminDatabase: (pool) => new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
  }),
  createCollaborationDatabase: (pool) => new Kysely<CollaborationPlatformDatabase>({
    dialect: new PostgresDialect({ pool }),
  }),
  createSchema: async (adminDb, schema) => {
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(adminDb);
  },
  dropSchema: async (adminDb, schema) => {
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(adminDb);
  },
  logCleanupError: (resource, error) => {
    console.error(`Failed to clean up real PostgreSQL test ${resource}`, error);
  },
};

interface RealPlatformCollaborationResources {
  adminPool?: Pool;
  adminDb?: Kysely<Record<string, never>>;
  schemaCreationAttempted: boolean;
  applicationPool?: Pool;
  collaborationDb?: Kysely<CollaborationPlatformDatabase>;
}

async function cleanupRealPlatformCollaborationResources(
  resources: RealPlatformCollaborationResources,
  schema: string,
  dependencies: RealPlatformCollaborationTestDatabaseDependencies,
): Promise<unknown | undefined> {
  let firstError: unknown;
  const attempt = async (resource: string, cleanup: () => Promise<void>): Promise<void> => {
    try {
      await cleanup();
    } catch (error) {
      firstError ??= error;
      try {
        dependencies.logCleanupError(resource, error);
      } catch (loggingError) {
        console.error(`Failed to report real PostgreSQL test ${resource} cleanup`, loggingError);
      }
    }
  };

  const collaborationDb = resources.collaborationDb;
  const applicationPool = resources.applicationPool;
  const adminDb = resources.adminDb;
  const adminPool = resources.adminPool;
  if (collaborationDb) {
    await attempt("application database", () => collaborationDb.destroy());
  } else if (applicationPool) {
    await attempt("application pool", () => applicationPool.end());
  }
  if (resources.schemaCreationAttempted && adminDb) {
    await attempt("schema", () => dependencies.dropSchema(adminDb, schema));
  }
  if (adminDb) {
    await attempt("admin database", () => adminDb.destroy());
  } else if (adminPool) {
    await attempt("admin pool", () => adminPool.end());
  }
  return firstError;
}

export async function createPlatformCollaborationTestDatabase(): Promise<PlatformCollaborationTestDatabase> {
  const fixture = await createTestPlatformDb();
  return {
    ...fixture,
    collaborationDb: fixture.db.kysely as unknown as Kysely<CollaborationPlatformDatabase>,
  };
}

export async function createRealPlatformCollaborationTestDatabase(
  connectionString = process.env.MATRIX_TEST_POSTGRES_URL,
  dependencies = defaultRealDatabaseDependencies,
): Promise<RealPlatformCollaborationTestDatabase> {
  if (!connectionString) throw new Error("MATRIX_TEST_POSTGRES_URL is required");
  const parsed = new URL(connectionString);
  if (!parsed.pathname.toLowerCase().includes("test")) {
    throw new Error("MATRIX_TEST_POSTGRES_URL must name a dedicated test database");
  }
  const schema = `platform_collaboration_${randomUUID().replaceAll("-", "")}`;
  const resources: RealPlatformCollaborationResources = { schemaCreationAttempted: false };
  try {
    resources.adminPool = dependencies.createPool({ connectionString, max: 1 });
    resources.adminDb = dependencies.createAdminDatabase(resources.adminPool);
    resources.schemaCreationAttempted = true;
    await dependencies.createSchema(resources.adminDb, schema);
    resources.applicationPool = dependencies.createPool({
      connectionString,
      max: 8,
      options: `-c search_path=${schema} -c statement_timeout=5000 -c lock_timeout=2000`,
    });
    resources.collaborationDb = dependencies.createCollaborationDatabase(resources.applicationPool);
  } catch (setupError) {
    await cleanupRealPlatformCollaborationResources(resources, schema, dependencies);
    throw setupError;
  }

  const collaborationDb = resources.collaborationDb;
  if (!collaborationDb) {
    const setupError = new Error("Real PostgreSQL collaboration test database was not created");
    await cleanupRealPlatformCollaborationResources(resources, schema, dependencies);
    throw setupError;
  }
  let destroyPromise: Promise<void> | undefined;
  return {
    collaborationDb,
    destroy: () => {
      destroyPromise ??= cleanupRealPlatformCollaborationResources(resources, schema, dependencies)
        .then((cleanupError) => {
          if (cleanupError) throw cleanupError;
        });
      return destroyPromise;
    },
  };
}

export async function destroyPlatformCollaborationTestDatabase(
  fixture: PlatformCollaborationTestDatabase | undefined,
): Promise<void> {
  await destroyTestPlatformDb(fixture?.db);
}
