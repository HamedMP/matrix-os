import type { Kysely } from "kysely";
import type { PlatformDatabase } from "../../packages/platform/src/db.js";
import { wrapPlatformDb } from "../../packages/platform/src/database/transaction-scope.js";
import { runPlatformStartupMigrations } from "../../packages/platform/src/database/run-migrations.js";
import { createRealPlatformCollaborationTestDatabase } from "./collaboration-test-support.js";

/** Owned random schema on the dedicated test server; never an application database. */
export async function createPreviewPairPostgresFixture() {
  const fixture = await createRealPlatformCollaborationTestDatabase();
  const root = fixture.collaborationDb as unknown as Kysely<PlatformDatabase>;
  try {
    await runPlatformStartupMigrations(root);
    return { db: wrapPlatformDb(root, root, Promise.resolve(), fixture.destroy), destroy: fixture.destroy };
  } catch (error: unknown) { await fixture.destroy(); throw error; }
}
