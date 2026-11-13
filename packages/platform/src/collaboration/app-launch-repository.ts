import { sql, type Kysely } from "kysely";
import type { CollaborationPlatformDatabase } from "./database.js";
import { CollaborativeAppLaunchError, type CollaborativeAppLaunchIdentity } from "./app-launch-sessions.js";

export interface PersistedAppLaunch {
  launchId: string;
  clientRequestId: string;
  identity: CollaborativeAppLaunchIdentity;
  createdAt: number;
  expiresAt: number;
}

/** Short-lived routing metadata only. Proof keys, owner sessions and app data stay out of platform storage. */
export class CollaborativeAppLaunchRepository {
  constructor(private readonly db: Kysely<CollaborationPlatformDatabase>) {}

  async get(launchId: string, scopeId: string, actorId: string | null, now: number): Promise<PersistedAppLaunch | null> {
    let query = this.db.selectFrom("collaboration_app_launches").selectAll()
      .where("launch_id", "=", launchId).where("scope_id", "=", scopeId)
      .where("expires_at", ">", new Date(now));
    if (actorId !== null) query = query.where("actor_id", "=", actorId);
    const row = await query.executeTakeFirst();
    return row ? { launchId: row.launch_id, clientRequestId: row.client_request_id, identity: row.identity,
      createdAt: new Date(row.created_at).getTime(), expiresAt: new Date(row.expires_at).getTime() } : null;
  }

  async save(input: PersistedAppLaunch, limits: { maxSessions: number; maxPerActor: number }, now: number): Promise<PersistedAppLaunch> {
    return this.db.transaction().execute(async (trx) => {
      // Admission, idempotency and global/per-actor bounds share one lock across platform instances.
      await sql`SELECT pg_advisory_xact_lock(hashtext('collaboration_app_launches'))`.execute(trx);
      await trx.deleteFrom("collaboration_app_launches").where("expires_at", "<=", new Date(now)).execute();
      const existing = await trx.selectFrom("collaboration_app_launches").selectAll()
        .where("actor_id", "=", input.identity.actorId).where("client_request_id", "=", input.clientRequestId).executeTakeFirst();
      if (existing) {
        const previous = existing.identity;
        if (Object.entries(input.identity).some(([key, value]) => previous[key as keyof CollaborativeAppLaunchIdentity] !== value)) {
          throw new CollaborativeAppLaunchError("conflict");
        }
        return { launchId: existing.launch_id, clientRequestId: existing.client_request_id, identity: previous,
          createdAt: new Date(existing.created_at).getTime(), expiresAt: new Date(existing.expires_at).getTime() };
      }
      const rows = await trx.selectFrom("collaboration_app_launches").select(["launch_id", "actor_id"])
        .orderBy("created_at", "asc").orderBy("launch_id", "asc").execute();
      const actorRows = rows.filter((row) => row.actor_id === input.identity.actorId);
      const evict = new Set(actorRows.slice(0, Math.max(0, actorRows.length - limits.maxPerActor + 1)).map((row) => row.launch_id));
      for (const row of rows) {
        if (rows.length - evict.size < limits.maxSessions) break;
        evict.add(row.launch_id);
      }
      if (evict.size) await trx.deleteFrom("collaboration_app_launches").where("launch_id", "in", [...evict]).execute();
      await trx.insertInto("collaboration_app_launches").values({
        launch_id: input.launchId, client_request_id: input.clientRequestId, actor_id: input.identity.actorId,
        scope_id: input.identity.scopeId, identity: input.identity,
        created_at: new Date(input.createdAt), expires_at: new Date(input.expiresAt),
      }).onConflict((conflict) => conflict.columns(["actor_id", "client_request_id"]).doNothing()).execute();
      return input;
    });
  }

  async revoke(scopeId: string, actorId?: string): Promise<void> {
    let query = this.db.deleteFrom("collaboration_app_launches").where("scope_id", "=", scopeId);
    if (actorId !== undefined) query = query.where("actor_id", "=", actorId);
    await query.execute();
  }

  async sweep(now: number): Promise<void> {
    await this.db.deleteFrom("collaboration_app_launches").where("expires_at", "<=", new Date(now)).execute();
  }
}
