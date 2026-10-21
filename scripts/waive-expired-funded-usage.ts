#!/usr/bin/env bun
/** Operator-only, exact reviewed private input. Default dry-run never runs migrations. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Kysely, PostgresDialect, sql } from "kysely";
import pg from "pg";
import { createExpiredUsageWaiver } from "../packages/platform/src/ai-funded-usage-waiver.js";
import { ExpiredUsageWaiverRequestSchema, waiverFingerprint } from "../packages/platform/src/ai-funded-usage-waiver-audit.js";
import { wrapPlatformDb } from "../packages/platform/src/database/transaction-scope.js";
import type { PlatformDatabase } from "../packages/platform/src/db.js";

export async function readReviewedWaiver(path: string) {
  // Nonblocking open lets fstat reject FIFOs/devices without waiting for a writer.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
      || metadata.uid !== process.getuid?.() || metadata.size < 1 || metadata.size > 64 * 1024) {
      throw new Error("A bounded owner-only private review file is required");
    }
    // Bound the read on the already checked FD, even if its writer changes it.
    const bytes = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== metadata.size || bytesRead > 64 * 1024) throw new Error("Private review file changed");
    return ExpiredUsageWaiverRequestSchema.parse(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } finally { await file.close(); }
}

export function parseWaiverArguments(args: string[]) {
  const [file, ...rest] = args;
  if (!file || (rest.length !== 0 && (rest.length !== 3 || rest[0] !== "--apply"
    || rest[1] !== "--reviewed-sha256" || !/^[a-f0-9]{64}$/.test(rest[2])))) {
    throw new Error("Usage: bun scripts/waive-expired-funded-usage.ts <private-review.json> [--apply --reviewed-sha256 <dry-run-fingerprint>]");
  }
  return { file, apply: rest.length > 0, reviewedFingerprint: rest[2] };
}

async function main() {
  const args = parseWaiverArguments(process.argv.slice(2));
  const request = await readReviewedWaiver(args.file);
  if (args.apply && args.reviewedFingerprint !== waiverFingerprint(request)) throw new Error("Review fingerprint changed");
  const connectionString = process.env.PLATFORM_DATABASE_URL;
  if (!connectionString) throw new Error("Operator database configuration is required");
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.searchParams.get("sslmode") !== "verify-full")) {
    throw new Error("Verified TLS is required for the operator database");
  }
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000, lock_timeout: 5_000,
    options: args.apply ? undefined : "-c default_transaction_read_only=on" });
  pool.on("error", () => { console.error("Operator database connection failed"); });
  const root = new Kysely<PlatformDatabase>({ dialect: new PostgresDialect({ pool }) });
  // Deliberately no createPlatformDb()/ready migration. Reviewed deployment owns schema changes.
  const db = wrapPlatformDb(root, root, Promise.resolve(), () => root.destroy());
  try {
    const current = await sql<{ generation: number }>`SELECT generation FROM platform_schema_revisions WHERE scope='core'`.execute(root);
    if ((current.rows[0]?.generation ?? 0) < 18) throw new Error("Deploy waiver-aware schema and settlement first");
    const result = await createExpiredUsageWaiver({ db, now: () => new Date() })(request, { apply: args.apply });
    console.log(JSON.stringify(result, null, 2));
  } finally { await db.destroy(); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Funded usage waiver failed; inspect private review and database state before retrying"); process.exitCode = 1; });
}
