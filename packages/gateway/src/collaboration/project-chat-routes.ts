/**
 * A shared project's Chats are inherited scopes: their members are the project's. Members reach
 * them through the platform directory, which routes each Chat beside its project and admits its
 * tickets from the project's membership. This module publishes those routes (once per Chat and
 * authority generation) and describes a shared project to its members.
 */
import {
  COLLABORATION_PROJECT_OVERVIEW_MAX_CHATS,
  CollaborationProjectOverviewSchema,
  type CollaborationProjectOverview,
} from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "./database.js";
import { jsonb, type ScopeRow } from "./repository-shared.js";

/** Marks a Chat whose route has been published at its current authority generation. */
export const PROJECT_CHAT_ROUTE_EVENT = "project.chat.route_published";

const MAX_ROUTES_PER_PASS = 200;
const FALLBACK_PROJECT_NAME = "Shared project";
const FALLBACK_CHAT_TITLE = "Untitled Chat";
const ScopeIdSchema = z.uuid();
const ChatSchema = CollaborationProjectOverviewSchema.shape.chats.element;
const NameSchema = CollaborationProjectOverviewSchema.shape.name;

type CollaborationTransaction = Transaction<OwnerCollaborationDatabase>;

export class ProjectOverviewError extends Error {
  constructor(public readonly code: "not_found" | "unavailable") {
    super("Shared project overview is unavailable");
    this.name = "ProjectOverviewError";
  }
}

/**
 * Publishes the route of every Chat of a shared project that has none at its current authority
 * generation. Runs inside the caller's transaction, so a route exists exactly when the Chat is
 * shared. Without `projectScopeId` it covers every shared project (the startup backfill).
 */
export async function publishProjectChatRoutes(
  trx: CollaborationTransaction,
  input: { projectScopeId?: string; now: Date; limit?: number },
): Promise<number> {
  let query = trx.selectFrom("collaboration_scopes as child")
    .innerJoin("collaboration_scopes as project", "project.id", "child.parent_scope_id")
    .selectAll("child")
    .where("child.kind", "=", "chat")
    .where("child.membership_mode", "=", "inherited")
    .where("child.lifecycle", "in", ["shared", "archived"])
    .where("child.deleted_at", "is", null)
    .where("child.organization_id", "is not", null)
    .where("project.kind", "=", "project")
    .where("project.membership_mode", "=", "direct")
    .where("project.lifecycle", "in", ["shared", "archived"])
    .where("project.deleted_at", "is", null)
    .whereRef("project.organization_id", "=", "child.organization_id")
    .whereRef("project.authority_runtime_id", "=", "child.authority_runtime_id")
    .where(({ not, exists, selectFrom }) => not(exists(
      selectFrom("collaboration_events as event").select("event.event_id")
        .whereRef("event.scope_id", "=", "child.id")
        .where("event.event_type", "=", PROJECT_CHAT_ROUTE_EVENT)
        .whereRef("event.authority_generation", "=", "child.authority_generation"),
    )));
  if (input.projectScopeId) query = query.where("child.parent_scope_id", "=", ScopeIdSchema.parse(input.projectScopeId));
  const children = await query.orderBy("child.id", "asc")
    .limit(input.limit ?? MAX_ROUTES_PER_PASS)
    .forUpdate("child")
    .execute();
  let published = 0;
  for (const child of children) {
    if (await publishRoute(trx, child, input.now)) published += 1;
  }
  return published;
}

/**
 * One route event per Chat and generation. The event insert is the idempotency point: a
 * concurrent publisher that lost the race inserts nothing, and only the winner queues the
 * directory row and the audit record.
 */
async function publishRoute(trx: CollaborationTransaction, child: ScopeRow, now: Date): Promise<boolean> {
  const latest = await trx.selectFrom("collaboration_events")
    .select(({ fn }) => fn.max("scope_seq").as("sequence"))
    .where("scope_id", "=", child.id)
    .executeTakeFirst();
  const eventId = randomUUID();
  const inserted = await trx.insertInto("collaboration_events").values({
    scope_id: child.id,
    scope_seq: Number(latest?.sequence ?? 0) + 1,
    event_id: eventId,
    resource_kind: child.kind,
    resource_id: child.resource_id,
    revision: Number(child.revision),
    authority_generation: Number(child.authority_generation),
    event_type: PROJECT_CHAT_ROUTE_EVENT,
    payload: jsonb({}),
    created_at: now,
  }).onConflict((conflict) => conflict.doNothing()).returning("event_id").executeTakeFirst();
  if (!inserted) return false;
  await trx.insertInto("collaboration_audit").values({
    scope_id: child.id,
    actor_id: child.owner_id,
    action: PROJECT_CHAT_ROUTE_EVENT,
    outcome: "completed",
    revision: Number(child.revision),
    reason_code: null,
    created_at: now,
  }).execute();
  await trx.insertInto("collaboration_directory_outbox").values({
    event_id: eventId,
    scope_id: child.id,
    // The platform admits this Chat from its project's members; it carries none of its own.
    recipient_actor_ids: jsonb([]),
    authority_runtime_id: child.authority_runtime_id,
    authority_generation: Number(child.authority_generation),
    resource_kind: child.kind,
    discovery_state: "accepted",
    retry_after: now,
    delivered_at: null,
    created_at: now,
  }).execute();
  return true;
}

/** Startup backfill for projects shared before Chat routes existed; bounded per pass. */
export async function publishMissingProjectChatRoutes(
  db: Kysely<OwnerCollaborationDatabase>,
  options: { now?: () => Date } = {},
): Promise<number> {
  const now = options.now ?? (() => new Date());
  return db.transaction().execute((trx) => publishProjectChatRoutes(trx, { now: now() }));
}

/** A shared project as members see it: its name and the Chats they can open, newest first. */
export async function readProjectOverview(
  db: Kysely<OwnerCollaborationDatabase>,
  input: {
    scopeId: string;
    projectName(ownerId: string, projectId: string): Promise<string | null>;
  },
): Promise<CollaborationProjectOverview> {
  const scopeId = ScopeIdSchema.parse(input.scopeId);
  const scope = await db.selectFrom("collaboration_scopes")
    .select(["id", "owner_id", "resource_id", "lifecycle", "authority_runtime_id", "authority_generation"])
    .where("id", "=", scopeId)
    .where("kind", "=", "project")
    .where("membership_mode", "=", "direct")
    .where("lifecycle", "in", ["shared", "archived"])
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!scope) throw new ProjectOverviewError("not_found");
  const [name, rows] = await Promise.all([
    input.projectName(scope.owner_id, scope.resource_id),
    db.selectFrom("collaboration_resource_bindings as binding")
      .innerJoin("collaboration_scopes as child", "child.id", "binding.resource_scope_id")
      .innerJoin("chats", "chats.id", "child.resource_id")
      .select(["child.id as scope_id", "child.resource_id as chat_id", "chats.title", "chats.updated_at"])
      .where("binding.project_scope_id", "=", scope.id)
      .where("binding.resource_kind", "=", "chat")
      .where("binding.authority_runtime_id", "=", scope.authority_runtime_id)
      .where("binding.authority_generation", "=", Number(scope.authority_generation))
      .where("child.kind", "=", "chat")
      .where("child.parent_scope_id", "=", scope.id)
      .where("child.membership_mode", "=", "inherited")
      .where("child.lifecycle", "in", ["shared", "archived"])
      .where("child.deleted_at", "is", null)
      .where("chats.owner_id", "=", scope.owner_id)
      .orderBy("chats.updated_at", "desc")
      .orderBy("child.id", "asc")
      .limit(COLLABORATION_PROJECT_OVERVIEW_MAX_CHATS)
      .execute(),
  ]);
  return CollaborationProjectOverviewSchema.parse({
    projectId: scope.resource_id,
    scopeId: scope.id,
    name: displayText(NameSchema, name, FALLBACK_PROJECT_NAME),
    status: scope.lifecycle === "archived" ? "archived" : "active",
    chats: rows.map((row) => ({
      scopeId: row.scope_id,
      chatId: row.chat_id,
      title: displayText(ChatSchema.shape.title, row.title, FALLBACK_CHAT_TITLE),
      updatedAt: new Date(row.updated_at).toISOString(),
    })),
  });
}

/** Members see only text that is safe to display; anything else is replaced, never sent as is. */
function displayText(schema: z.ZodType<string>, value: string | null | undefined, fallback: string): string {
  const parsed = schema.safeParse(value?.trim());
  return parsed.success ? parsed.data : fallback;
}
