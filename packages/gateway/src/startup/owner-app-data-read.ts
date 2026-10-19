import { sql, type Kysely } from "kysely";
import { OwnerAppReadGrantSchema, type OwnerAppReadAudit, type OwnerAppReadGrant } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { AppRegistry } from "../app-db-registry.js";
import type { QueryEngine } from "../app-db-query.js";
import { registerOwnerAppDataReadRoutes } from "../app-data-read-routes.js";
import type { Hono } from "hono";

const AuditSchema = z.strictObject({
  ownerId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).optional(),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/).optional(),
  runtimeHandle: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/).optional(),
  app: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/).optional(),
  table: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/).optional(),
  action: z.enum(["listApps", "schema", "find"]).optional(), outcome: z.enum(["allowed", "denied", "error"]),
});

/** Installed-app discovery runs before every native Chat turn; a hung registry query must not stall Chat. */
export const APP_READ_DISCOVERY_TIMEOUT_MS = 5_000;

function withDeadline<T>(work: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { const error = new Error(name); error.name = name; reject(error); }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Owns no pool. Startup owns DDL; security audits are the only writes. */
export async function createOwnerAppDataReadRuntime(options: {
  apps: AppRegistry | null; queryEngine: QueryEngine | null; kysely: Kysely<any> | null;
  ownerId: string; runtimeHandle: string;
}) {
  const { apps, queryEngine, kysely, ownerId, runtimeHandle } = options;
  if (!apps?.get || !apps.listApps || !queryEngine?.find || !kysely?.transaction
    || !/^[A-Za-z0-9_-]{1,256}$/.test(ownerId)
    || !OwnerAppReadGrantSchema.safeParse({ runtimeHandle, apps: [] }).success) throw new Error("App read dependencies unavailable");
  await sql`CREATE TABLE IF NOT EXISTS public._app_data_read_audit (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    created_at timestamptz NOT NULL DEFAULT now(), event jsonb NOT NULL
  )`.execute(kysely);
  const audit: OwnerAppReadAudit = async event => {
    const safe = AuditSchema.parse(event);
    await kysely.transaction().execute(async trx => {
      await sql`SELECT set_config('statement_timeout', '5000', true)`.execute(trx);
      // Serialize insert/retention as one transaction so concurrent runs cannot
      // exceed the owner-local cap or delete an uncommitted audit entry.
      await sql`SELECT pg_advisory_xact_lock(289)`.execute(trx);
      await sql`INSERT INTO public._app_data_read_audit (event) VALUES (${JSON.stringify(safe)}::jsonb)`.execute(trx);
      await sql`DELETE FROM public._app_data_read_audit WHERE id IN (
        SELECT id FROM public._app_data_read_audit ORDER BY id DESC OFFSET 10000
      )`.execute(trx);
    });
  };
  async function resolveGrant(owner: { type: string; ownerId: string }): Promise<OwnerAppReadGrant | null> {
    if (owner.type !== "personal" || owner.ownerId !== ownerId) return null;
    const installed = await withDeadline(apps!.listApps(65), APP_READ_DISCOVERY_TIMEOUT_MS, "AppReadDiscoveryTimeout");
    const eligible: OwnerAppReadGrant["apps"] = [];
    for (const app of installed) {
      if (!app.tables || typeof app.tables !== "object" || Array.isArray(app.tables)) continue;
      const parsed = OwnerAppReadGrantSchema.safeParse({ runtimeHandle, apps: [
        { app: app.slug, schema: app.slug, tables: Object.keys(app.tables) },
      ] });
      if (parsed.success) eligible.push(parsed.data.apps[0]!);
      if (eligible.length === 64) break;
    }
    return { runtimeHandle, apps: eligible };
  }
  return { audit, resolveGrant, auth: { runtimeHandle, audit }, register(app: Hono) {
    registerOwnerAppDataReadRoutes(app, { appRegistry: apps, queryEngine, configuredOwnerId: ownerId, runtimeHandle, audit });
  } };
}
