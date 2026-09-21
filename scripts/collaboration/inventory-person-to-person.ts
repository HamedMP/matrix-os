/**
 * S20 / T102: count person-to-person collaboration records.
 *
 * Usage (read-only; prints JSON):
 *   GATEWAY_DATABASE_URL=postgres://... PLATFORM_DATABASE_URL=postgres://... \
 *     pnpm exec tsx scripts/collaboration/inventory-person-to-person.ts
 * Either variable may be omitted to inventory one side only.
 */
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { inventoryPersonToPersonRecords } from "../../packages/gateway/src/collaboration/person-to-person-inventory.js";
import { inventoryPersonalSyncShares } from "../../packages/gateway/src/sync/share-inventory.js";
import { inventoryPlatformPersonToPersonRecords } from "../../packages/platform/src/collaboration/person-to-person-inventory.js";

async function withDatabase<T>(url: string, run: (db: Kysely<any>) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  const db = new Kysely<any>({ dialect: new PostgresDialect({ pool }) });
  try {
    return await run(db);
  } finally {
    await db.destroy();
  }
}

const gatewayUrl = process.env.GATEWAY_DATABASE_URL;
const platformUrl = process.env.PLATFORM_DATABASE_URL;
if (!gatewayUrl && !platformUrl) {
  console.error("Set GATEWAY_DATABASE_URL and/or PLATFORM_DATABASE_URL");
  process.exit(2);
}
const gatewayInventory = gatewayUrl ? await withDatabase(gatewayUrl, async (db) => ({
  collaboration: await inventoryPersonToPersonRecords(db),
  personalSync: await inventoryPersonalSyncShares(db),
})) : null;
const result = {
  recordedAt: new Date().toISOString(),
  gateway: gatewayInventory?.collaboration ?? null,
  /** Separate personal operation; excluded from gateway/platform collaboration totals. */
  personalSync: gatewayInventory?.personalSync ?? null,
  platform: platformUrl ? await withDatabase(platformUrl, inventoryPlatformPersonToPersonRecords) : null,
};
console.log(JSON.stringify(result, null, 2));
