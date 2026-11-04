import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import type { PlatformDatabase } from "../packages/platform/src/db.js";
import { wrapPlatformDb } from "../packages/platform/src/database/transaction-scope.js";
import { inventoryExpiredCustomerCharges } from "../packages/platform/src/ai-funded-customer-credit-cleanup.js";

export function parseCustomerCreditInventoryArguments(args: string[]) {
  if (args.length > 2) throw new Error("Usage: inventory-expired-customer-credit.ts [limit] [base64url-cursor]");
  const limit = z.coerce.number().int().min(1).max(1000).parse(args[0] ?? 100);
  const after = args[1] ? JSON.parse(Buffer.from(z.string().max(512).regex(/^[A-Za-z0-9_-]+$/).parse(args[1]), "base64url").toString("utf8")) : undefined;
  return { limit, after };
}

async function main() {
  const input = parseCustomerCreditInventoryArguments(process.argv.slice(2));
  const connectionString = process.env.PLATFORM_DATABASE_URL;
  if (!connectionString) throw new Error("Operator database configuration is required");
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.searchParams.get("sslmode") !== "verify-full")) {
    throw new Error("Verified TLS is required for the operator database");
  }
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, lock_timeout: 5_000, options: "-c default_transaction_read_only=on" });
  pool.on("error", () => { console.error("Operator database connection failed"); });
  const root = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
  // Inventory never runs startup migrations or accepts an apply flag.
  const db = wrapPlatformDb(root, root, Promise.resolve(), () => root.destroy());
  try {
    const result = await root.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const revision = await sql<{ generation: number }>`SELECT generation FROM platform_schema_revisions WHERE scope='core'`.execute(trx);
      if ((revision.rows[0]?.generation ?? 0) < 24) throw new Error("Postpaid-aware schema is required");
      const readonlyDb = wrapPlatformDb(root, trx, Promise.resolve(), () => root.destroy(), true);
      return inventoryExpiredCustomerCharges({ db: readonlyDb, now: () => new Date() }, input);
    });
    console.log(JSON.stringify({ ...result, nextCursor: result.nextCursor
      ? Buffer.from(JSON.stringify(result.nextCursor)).toString("base64url") : null }, null, 2));
  } finally { await db.destroy(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Customer credit inventory failed; no financial changes were applied"); process.exitCode = 1; });
}
