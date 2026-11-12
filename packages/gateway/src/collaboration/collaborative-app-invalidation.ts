import { sql, type Transaction } from "kysely";

import type { OwnerCollaborationDatabase } from "./database.js";
import { appendMutationRecords } from "./repository-shared.js";

/**
 * Moves every active share bound to an invalidated certificate into
 * `needs_recheck` and publishes a strictly newer directory revision.
 * Callers perform the readiness update and this projection in one transaction.
 */
export async function publishCollaborativeAppInvalidations(
  executor: Transaction<OwnerCollaborationDatabase>,
  readinessIds: readonly string[],
  timestamp: Date,
): Promise<void> {
  if (readinessIds.length === 0) return;

  const candidates = await executor.selectFrom("collaboration_app_bindings as binding")
    .innerJoin("collaboration_scopes as scope", "scope.id", "binding.scope_id")
    .select(["scope.id", "scope.owner_id", "scope.revision"])
    .where("binding.readiness_id", "in", readinessIds)
    .where("binding.state", "=", "active")
    .where("scope.lifecycle", "=", "shared")
    .where("scope.deleted_at", "is", null)
    .orderBy("scope.id", "asc")
    .forUpdate("scope")
    .execute();

  for (const candidate of candidates) {
    const binding = await executor.selectFrom("collaboration_app_bindings")
      .select(["revision", "readiness_id"])
      .where("scope_id", "=", candidate.id)
      .where("readiness_id", "in", readinessIds)
      .where("state", "=", "active")
      .forUpdate()
      .executeTakeFirst();
    if (!binding) continue;

    const scope = await executor.updateTable("collaboration_scopes").set({
      revision: sql<number>`revision + 1`,
      auth_epoch: sql<number>`auth_epoch + 1`,
      updated_at: timestamp,
    }).where("id", "=", candidate.id)
      .where("revision", "=", Number(candidate.revision))
      .where("lifecycle", "=", "shared")
      .returningAll()
      .executeTakeFirst();
    if (!scope) throw new Error("Collaborative app share changed during invalidation");

    const updatedBinding = await executor.updateTable("collaboration_app_bindings").set({
      state: "needs_recheck",
      revision: Number(binding.revision) + 1,
      updated_at: timestamp,
    }).where("scope_id", "=", candidate.id)
      .where("revision", "=", Number(binding.revision))
      .where("state", "=", "active")
      .returning("scope_id")
      .executeTakeFirst();
    if (!updatedBinding) throw new Error("Collaborative app binding changed during invalidation");

    await appendMutationRecords(executor, {
      scope,
      actorId: candidate.owner_id,
      action: "app.share.needs_recheck",
      recipients: [{ actorId: candidate.owner_id }],
      discoveryState: "accepted",
      now: timestamp.toISOString(),
      reasonCode: "readiness_invalidated",
    });
  }
}

/** Restores a drifted share after an exact current build passes readiness again. */
export async function publishCollaborativeAppRecovery(
  executor: Transaction<OwnerCollaborationDatabase>,
  readiness: {
    id: string;
    owner_id: string;
    catalog_id: string;
    registration_incarnation: string;
    build_id: string;
  },
  timestamp: Date,
): Promise<void> {
  const candidates = await executor.selectFrom("collaboration_app_bindings as binding")
    .innerJoin("collaboration_scopes as scope", "scope.id", "binding.scope_id")
    .innerJoin("collaboration_resource_catalog as catalog", "catalog.id", "binding.catalog_id")
    .select(["scope.id", "scope.owner_id", "scope.revision"])
    .where("binding.catalog_id", "=", readiness.catalog_id)
    .where("binding.build_id", "=", readiness.build_id)
    .where("binding.registration_incarnation", "=", readiness.registration_incarnation)
    .where("binding.state", "=", "needs_recheck")
    .where("scope.owner_id", "=", readiness.owner_id)
    .where("scope.lifecycle", "=", "shared")
    .where("scope.deleted_at", "is", null)
    .where("catalog.deleted_at", "is", null)
    .where("catalog.incarnation", "=", readiness.registration_incarnation)
    .orderBy("scope.id", "asc")
    .forUpdate("scope")
    .execute();

  for (const candidate of candidates) {
    const binding = await executor.selectFrom("collaboration_app_bindings")
      .select("revision")
      .where("scope_id", "=", candidate.id)
      .where("catalog_id", "=", readiness.catalog_id)
      .where("build_id", "=", readiness.build_id)
      .where("registration_incarnation", "=", readiness.registration_incarnation)
      .where("state", "=", "needs_recheck")
      .forUpdate()
      .executeTakeFirst();
    if (!binding) continue;

    const scope = await executor.updateTable("collaboration_scopes").set({
      revision: sql<number>`revision + 1`,
      auth_epoch: sql<number>`auth_epoch + 1`,
      updated_at: timestamp,
    }).where("id", "=", candidate.id)
      .where("revision", "=", Number(candidate.revision))
      .where("lifecycle", "=", "shared")
      .returningAll()
      .executeTakeFirst();
    if (!scope) throw new Error("Collaborative app share changed during recovery");

    const recovered = await executor.updateTable("collaboration_app_bindings").set({
      readiness_id: readiness.id,
      state: "active",
      revision: Number(binding.revision) + 1,
      updated_at: timestamp,
      stopped_at: null,
    }).where("scope_id", "=", candidate.id)
      .where("revision", "=", Number(binding.revision))
      .where("build_id", "=", readiness.build_id)
      .where("registration_incarnation", "=", readiness.registration_incarnation)
      .where("state", "=", "needs_recheck")
      .returning("scope_id")
      .executeTakeFirst();
    if (!recovered) throw new Error("Collaborative app binding changed during recovery");

    await appendMutationRecords(executor, {
      scope,
      actorId: candidate.owner_id,
      action: "app.share.recovered",
      recipients: [{ actorId: candidate.owner_id }],
      discoveryState: "accepted",
      now: timestamp.toISOString(),
      reasonCode: "readiness_recovered",
    });
  }
}
