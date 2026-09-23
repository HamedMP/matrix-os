import type { Context, Hono } from "hono";
import { createPlatformDb, type PlatformDb } from "../platform-db.js";
import { createPipedreamClient, type PipedreamConnectClient } from "../integrations/pipedream.js";
import { createIntegrationRoutes } from "../integrations/routes.js";
import { discoverComponentKeys } from "../integrations/registry.js";
import type { ServerMessage } from "../server/types.js";

export interface PlatformIntegrationServices {
  db: PlatformDb | null;
  client: PipedreamConnectClient | null;
  routes: Hono | null;
  resolveUserId: ((c: Context) => Promise<string | null>) | null;
}

export interface PlatformIntegrationOptions {
  env: NodeJS.ProcessEnv;
  broadcast(message: ServerMessage): void;
  createDb?: typeof createPlatformDb;
  createClient?: typeof createPipedreamClient;
}

export async function initializePlatformIntegrations(
  options: PlatformIntegrationOptions,
): Promise<PlatformIntegrationServices> {
  const { env, broadcast } = options;
  const absent: PlatformIntegrationServices = {
    db: null, client: null, routes: null, resolveUserId: null,
  };
  if (!env.PLATFORM_DATABASE_URL || !env.PIPEDREAM_CLIENT_ID
    || !env.PIPEDREAM_CLIENT_SECRET || !env.PIPEDREAM_PROJECT_ID) {
    return absent;
  }

  let db: PlatformDb | null = null;
  try {
    db = (options.createDb ?? createPlatformDb)(env.PLATFORM_DATABASE_URL);
    await db.migrate();
    console.log("[platform-db] Initialized");
    const client = await (options.createClient ?? createPipedreamClient)({
      clientId: env.PIPEDREAM_CLIENT_ID,
      clientSecret: env.PIPEDREAM_CLIENT_SECRET,
      projectId: env.PIPEDREAM_PROJECT_ID,
      environment: env.PIPEDREAM_ENVIRONMENT ?? "production",
    });
    const resolveUserId = createIntegrationUserResolver(db, env);
    const routes = createIntegrationRoutes({
      db,
      pipedream: client,
      webhookSecret: (() => {
        const secret = env.PIPEDREAM_WEBHOOK_SECRET;
        if (!secret) console.warn("[integrations] PIPEDREAM_WEBHOOK_SECRET not set -- webhooks will be rejected");
        return secret ?? "";
      })(),
      resolveUserId,
      broadcast,
    });
    console.log("[platform-db] Integration routes ready");
    discoverComponentKeys(client)
      .then((stats) => {
        console.log(`[integrations] Component keys discovered: ${stats.matched}/${stats.total} matched, ${stats.errors} errors`);
      })
      .catch((error: unknown) => {
        console.error("[integrations] Component key discovery failed:", error instanceof Error ? error.message : error);
      });
    return { db, client, routes, resolveUserId };
  } catch (error: unknown) {
    console.error("[platform-db] Failed to initialize:", error instanceof Error ? error.message : error);
    if (db) {
      try {
        await db.destroy();
      } catch (closeError: unknown) {
        console.error("[platform-db] Failed to close after startup failure:",
          closeError instanceof Error ? closeError.name : "UnknownError");
      }
    }
    return absent;
  }
}

/** Resolve the owner behind integration routes using the platform verified identity. */
export function createIntegrationUserResolver(
  db: PlatformDb,
  env: NodeJS.ProcessEnv,
): (c: Context) => Promise<string | null> {
  return async (c) => {
    // ---- Path A: prod / platform header ----
    const clerkIdFromPlatform = c.req.header("x-platform-user-id");
    if (clerkIdFromPlatform) {
      try {
        const user = await db.getUserByClerkId(clerkIdFromPlatform);
        if (!user) {
          // Genuine auth failure: header is present but no platform row.
          // The user signed in via Clerk but their container/platform-db
          // row hasn't been provisioned yet. Distinct from a DB error.
          console.warn("[integrations][auth] no_user_for_clerk_id:", clerkIdFromPlatform.slice(0, 32));
          return null;
        }
        return user.id;
      } catch (err) {
        // Platform DB is down or query failed. This is a 500 masquerading
        // as a 401. Log loudly so the symptom (401 to client) maps to the
        // root cause (DB outage) without trial-and-error debugging.
        console.error(
          "[integrations][auth] db_error during getUserByClerkId:",
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }

    // ---- Path B: prod with no header = locked out (not an error) ----
    if (env.NODE_ENV === "production") {
      // Not console.error -- this is a routine "missing header" outcome,
      // not a server fault. The proxy is supposed to inject this header;
      // if it isn't, that's a deployment issue, not a per-request error.
      console.warn("[integrations][auth] no_platform_header_in_production");
      return null;
    }

    // ---- Path C: dev env-var fallback ----
    const handle = env.MATRIX_HANDLE ?? "default";
    const clerkId = env.MATRIX_CLERK_USER_ID ?? handle;
    const containerId = env.HOSTNAME ?? "local";

    // Atomic upsert eliminates the SELECT->INSERT TOCTOU race that could
    // let two concurrent first-time dev requests both reach createUser and
    // have one fail on the unique constraint. ON CONFLICT covers the
    // common case (same env vars across parallel requests => same
    // clerk_id). On match, backfill pipedream_external_id if missing.
    try {
      const upserted = await db.raw(
        `INSERT INTO users (clerk_id, handle, display_name, email, container_id, pipedream_external_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (clerk_id) DO UPDATE
           SET pipedream_external_id = COALESCE(users.pipedream_external_id, EXCLUDED.pipedream_external_id)
         RETURNING id`,
        [clerkId, handle, handle, `${handle}@matrix-os.local`, containerId, handle],
      );
      const row = upserted.rows[0] as { id: string } | undefined;
      if (row) return row.id;
      console.warn("[integrations][auth] dev_upsert_returned_no_row");
      return null;
    } catch (err) {
      // The upsert handles clerk_id conflicts but not handle/container_id
      // ones. Those occur when MATRIX_CLERK_USER_ID was changed between
      // runs and the orphaned row still owns the handle. Try to recover
      // by returning the orphaned row so dev keeps working without a wipe.
      try {
        const byHandle = await db.raw(
          `SELECT id, pipedream_external_id FROM users WHERE handle = $1 LIMIT 1`,
          [handle],
        );
        if (byHandle.rows.length > 0) {
          const row = byHandle.rows[0] as { id: string; pipedream_external_id: string | null };
          if (!row.pipedream_external_id) {
            await db.updatePipedreamExternalId(row.id, handle);
          }
          return row.id;
        }
        // Upsert raised, recovery SELECT found nothing. Whatever caused
        // the original error is real (DB down, schema drift, etc.).
        console.error(
          "[integrations][auth] db_error during dev fallback upsert (recovery select empty):",
          err instanceof Error ? err.message : err,
        );
        return null;
      } catch (recoveryErr) {
        // Both queries failed -- DB is genuinely unreachable.
        console.error(
          "[integrations][auth] db_error during dev fallback (both upsert and recovery failed):",
          err instanceof Error ? err.message : err,
          "recovery:",
          recoveryErr instanceof Error ? recoveryErr.message : recoveryErr,
        );
        return null;
      }
    }
  };
}
