import type { Kysely } from "kysely";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { CollaborationPlatformDatabase } from "../../packages/platform/src/collaboration/database.js";
import {
  createRealPlatformCollaborationTestDatabase,
  type RealPlatformCollaborationTestDatabaseDependencies,
} from "./collaboration-test-support.js";

const connectionString = "postgresql://matrix:test@127.0.0.1/matrix_test";

function fakePool(destroy: () => Promise<void>): Pool {
  return { end: destroy } as unknown as Pool;
}

function fakeDatabase<Database>(destroy: () => Promise<void>): Kysely<Database> {
  return { destroy } as unknown as Kysely<Database>;
}

describe("createRealPlatformCollaborationTestDatabase", () => {
  it("closes the raw admin pool when admin database construction fails", async () => {
    const setupError = new Error("admin database construction failed");
    const adminPoolEnd = vi.fn(async () => undefined);
    const dependencies: RealPlatformCollaborationTestDatabaseDependencies = {
      createPool: vi.fn(() => fakePool(adminPoolEnd)),
      createAdminDatabase: vi.fn(() => {
        throw setupError;
      }),
      createCollaborationDatabase: vi.fn(),
      createSchema: vi.fn(),
      dropSchema: vi.fn(),
      logCleanupError: vi.fn(),
    };

    await expect(createRealPlatformCollaborationTestDatabase(connectionString, dependencies))
      .rejects.toBe(setupError);
    expect(adminPoolEnd).toHaveBeenCalledOnce();
    expect(dependencies.dropSchema).not.toHaveBeenCalled();
  });

  it("attempts schema removal when schema creation itself rejects", async () => {
    const setupError = new Error("schema creation result was lost");
    const cleanupOrder: string[] = [];
    const adminDb = fakeDatabase<Record<string, never>>(async () => {
      cleanupOrder.push("admin-database");
    });
    const dependencies: RealPlatformCollaborationTestDatabaseDependencies = {
      createPool: vi.fn(() => fakePool(async () => undefined)),
      createAdminDatabase: vi.fn(() => adminDb),
      createCollaborationDatabase: vi.fn(),
      createSchema: vi.fn(async () => {
        throw setupError;
      }),
      dropSchema: vi.fn(async () => {
        cleanupOrder.push("schema");
      }),
      logCleanupError: vi.fn(),
    };

    await expect(createRealPlatformCollaborationTestDatabase(connectionString, dependencies))
      .rejects.toBe(setupError);
    expect(cleanupOrder).toEqual(["schema", "admin-database"]);
  });

  it("cleans partial setup in dependency order and preserves the setup error", async () => {
    const setupError = new Error("application database construction failed");
    const cleanupError = new Error("application pool cleanup failed");
    const cleanupOrder: string[] = [];
    const adminPoolEnd = vi.fn(async () => {
      cleanupOrder.push("admin-pool");
    });
    const adminPool = fakePool(adminPoolEnd);
    const applicationPool = fakePool(async () => {
      cleanupOrder.push("application-pool");
      throw cleanupError;
    });
    const adminDb = fakeDatabase<Record<string, never>>(async () => {
      cleanupOrder.push("admin-database");
    });
    const log = vi.fn();
    const dependencies: RealPlatformCollaborationTestDatabaseDependencies = {
      createPool: vi.fn()
        .mockReturnValueOnce(adminPool)
        .mockReturnValueOnce(applicationPool),
      createAdminDatabase: vi.fn(() => adminDb),
      createCollaborationDatabase: vi.fn(() => {
        throw setupError;
      }),
      createSchema: vi.fn(async () => undefined),
      dropSchema: vi.fn(async () => {
        cleanupOrder.push("schema");
      }),
      logCleanupError: log,
    };

    await expect(createRealPlatformCollaborationTestDatabase(connectionString, dependencies))
      .rejects.toBe(setupError);

    expect(cleanupOrder).toEqual(["application-pool", "schema", "admin-database"]);
    expect(log).toHaveBeenCalledWith("application pool", cleanupError);
    expect(adminPoolEnd).not.toHaveBeenCalled();
  });

  it("returns an idempotent destroy that attempts every cleanup step in order", async () => {
    const cleanupOrder: string[] = [];
    const adminDb = fakeDatabase<Record<string, never>>(async () => {
      cleanupOrder.push("admin-database");
    });
    const collaborationDb = fakeDatabase<CollaborationPlatformDatabase>(async () => {
      cleanupOrder.push("application-database");
      throw new Error("application database cleanup failed");
    });
    const dependencies: RealPlatformCollaborationTestDatabaseDependencies = {
      createPool: vi.fn()
        .mockReturnValueOnce(fakePool(async () => undefined))
        .mockReturnValueOnce(fakePool(async () => undefined)),
      createAdminDatabase: vi.fn(() => adminDb),
      createCollaborationDatabase: vi.fn(() => collaborationDb),
      createSchema: vi.fn(async () => undefined),
      dropSchema: vi.fn(async () => {
        cleanupOrder.push("schema");
      }),
      logCleanupError: vi.fn(),
    };

    const fixture = await createRealPlatformCollaborationTestDatabase(connectionString, dependencies);
    const firstDestroy = fixture.destroy();
    const secondDestroy = fixture.destroy();

    expect(firstDestroy).toBe(secondDestroy);
    await expect(firstDestroy).rejects.toThrow("application database cleanup failed");
    expect(cleanupOrder).toEqual(["application-database", "schema", "admin-database"]);
  });
});
