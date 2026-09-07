import type { Kysely } from "kysely";
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

export async function createPlatformCollaborationTestDatabase(): Promise<PlatformCollaborationTestDatabase> {
  const fixture = await createTestPlatformDb();
  return {
    ...fixture,
    collaborationDb: fixture.db.kysely as unknown as Kysely<CollaborationPlatformDatabase>,
  };
}

export async function destroyPlatformCollaborationTestDatabase(
  fixture: PlatformCollaborationTestDatabase | undefined,
): Promise<void> {
  await destroyTestPlatformDb(fixture?.db);
}
