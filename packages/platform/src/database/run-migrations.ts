import type { Kysely } from "kysely";
import type { PlatformDatabase } from "../db.js";
import { runPlatformMigration } from "../migration-runner.js";
import { PLATFORM_SCHEMA_REVISION } from "./migration-revision.js";
import { migratePlatformSchema } from "./migrate.js";
import { migrateNativeLive } from "../native-live/migration.js";
import { NATIVE_LIVE_SCHEMA_REVISION } from "../native-live/migration-revision.js";
import { migrateFundedProbeBudget } from "../funded-probe-budget-migration.js";
import { FUNDED_PROBE_BUDGET_SCHEMA_REVISION } from "../funded-probe-budget-migration-revision.js";

/** Composition only. Each feature owns its additive DDL and version; previews
 * may be based on an older core than the shared staging database. */
export async function migratePlatformDatabase(db: Kysely<PlatformDatabase>): Promise<void> {
  await runPlatformMigration(db, migratePlatformSchema, { revision: PLATFORM_SCHEMA_REVISION, deadlockAttempts: 12 });
  await runPlatformMigration(db, migrateNativeLive, { scope: "native-live", revision: NATIVE_LIVE_SCHEMA_REVISION, deadlockAttempts: 12 });
  await runPlatformMigration(db, migrateFundedProbeBudget, { scope: "funded-probe-budget", revision: FUNDED_PROBE_BUDGET_SCHEMA_REVISION, deadlockAttempts: 12 });
}
