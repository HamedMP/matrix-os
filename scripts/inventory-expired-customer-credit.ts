import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod/v4";
import type { PlatformDatabase } from "../packages/platform/src/db.js";
import { wrapPlatformDb } from "../packages/platform/src/database/transaction-scope.js";
import { inventoryExpiredCustomerCharges } from "../packages/platform/src/ai-funded-customer-credit-cleanup.js";

type InventoryPreconditionCode = "USAGE" | "MISSING_DATABASE_URL" | "INVALID_DATABASE_URL" | "TLS_REQUIRED" | "SCHEMA_TOO_OLD";
class InventoryPreconditionError extends Error {
  constructor(readonly code: InventoryPreconditionCode) { super("Inventory precondition failed"); }
}
function inventoryDiagnostic(error: unknown): { category: string; code: string } {
  if (error instanceof InventoryPreconditionError) {
    switch (error.code) {
      case "USAGE": return { category: "input", code: "USAGE" };
      case "SCHEMA_TOO_OLD": return { category: "schema", code: "SCHEMA_TOO_OLD" };
      case "MISSING_DATABASE_URL": return { category: "configuration", code: "MISSING_DATABASE_URL" };
      case "INVALID_DATABASE_URL": return { category: "configuration", code: "INVALID_DATABASE_URL" };
      case "TLS_REQUIRED": return { category: "configuration", code: "TLS_REQUIRED" };
    }
  }
  if (error instanceof z.ZodError) return { category: "input", code: "INVALID_ARGUMENTS" };
  if (error instanceof SyntaxError) return { category: "input", code: "CURSOR_JSON" };
  if (error instanceof pg.DatabaseError) {
    switch (error.code) {
      case "57014": return { category: "timeout", code: "57014" };
      case "42P01": return { category: "schema", code: "42P01" };
      case "42703": return { category: "schema", code: "42703" };
      case "28P01": return { category: "authentication", code: "28P01" };
      case "08006": return { category: "connection", code: "08006" };
      default: return { category: "database", code: "UNCLASSIFIED" };
    }
  }
  if (error instanceof Error) {
    switch ((error as NodeJS.ErrnoException).code) {
      case "ETIMEDOUT": return { category: "timeout", code: "ETIMEDOUT" };
      case "ECONNREFUSED": return { category: "connection", code: "ECONNREFUSED" };
      case "ECONNRESET": return { category: "connection", code: "ECONNRESET" };
      case "ENOTFOUND": return { category: "connection", code: "ENOTFOUND" };
      default:
        // pg-pool wraps these two local timeout failures without a machine code.
        // Match only its fixed messages; neither the message nor cause is emitted.
        if (error.message === "timeout exceeded when trying to connect" || error.message === "Connection terminated due to connection timeout") {
          return { category: "timeout", code: "POOL_CONNECTION_TIMEOUT" };
        }
        return { category: "unexpected", code: "UNCLASSIFIED" };
    }
  }
  return { category: "unknown", code: "UNCLASSIFIED" };
}
export function formatCustomerCreditInventoryError(error: unknown, stage: "inventory" | "pool" = "inventory") {
  const diagnostic = inventoryDiagnostic(error);
  const message = stage === "pool" ? "Operator database connection failed"
    : "Customer credit inventory failed; no financial changes were applied";
  return `${message} [category=${diagnostic.category} code=${diagnostic.code}]`;
}

export function parseCustomerCreditInventoryArguments(args: string[]) {
  if (args.length > 2) throw new InventoryPreconditionError("USAGE");
  const limit = z.coerce.number().int().min(1).max(1000).parse(args[0] ?? 100);
  const after = args[1] ? JSON.parse(Buffer.from(z.string().max(512).regex(/^[A-Za-z0-9_-]+$/).parse(args[1]), "base64url").toString("utf8")) : undefined;
  return { limit, after };
}

async function main(args: string[], env: NodeJS.ProcessEnv) {
  const input = parseCustomerCreditInventoryArguments(args);
  const connectionString = env.PLATFORM_DATABASE_URL;
  if (!connectionString) throw new InventoryPreconditionError("MISSING_DATABASE_URL");
  let url: URL;
  try { url = new URL(connectionString); }
  catch (error) { if (error instanceof TypeError) throw new InventoryPreconditionError("INVALID_DATABASE_URL"); throw error; }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.searchParams.get("sslmode") !== "verify-full")) {
    throw new InventoryPreconditionError("TLS_REQUIRED");
  }
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, lock_timeout: 5_000, options: "-c default_transaction_read_only=on" });
  pool.on("error", error => { console.error(formatCustomerCreditInventoryError(error, "pool")); });
  const root = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
  // Inventory never runs startup migrations or accepts an apply flag.
  const db = wrapPlatformDb(root, root, Promise.resolve(), () => root.destroy());
  try {
    const result = await root.transaction().setIsolationLevel("repeatable read").execute(async trx => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const revision = await sql<{ generation: number }>`SELECT generation FROM platform_schema_revisions WHERE scope='core'`.execute(trx);
      if ((revision.rows[0]?.generation ?? 0) < 24) throw new InventoryPreconditionError("SCHEMA_TOO_OLD");
      const readonlyDb = wrapPlatformDb(root, trx, Promise.resolve(), () => root.destroy(), true);
      return inventoryExpiredCustomerCharges({ db: readonlyDb, now: () => new Date() }, input);
    });
    console.log(JSON.stringify({ ...result, nextCursor: result.nextCursor
      ? Buffer.from(JSON.stringify(result.nextCursor)).toString("base64url") : null }, null, 2));
  } finally { await db.destroy(); }
}

export async function runCustomerCreditInventory(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env) {
  try { await main(args, env); return 0; }
  catch (error) { console.error(formatCustomerCreditInventoryError(error)); return 1; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  void runCustomerCreditInventory().then(status => { process.exitCode = status; });
}
