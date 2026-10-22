import type { CanonicalChatCollaboration } from "@matrix-os/contracts";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner } from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;

// Owner cleanup and run cancellation still need a safe public projection after the
// deletion fence. Deleted scopes remain excluded; execution guards stay unchanged.
export function sharedBindingScopeId(value: unknown): string | undefined {
  if (value === null) return undefined;
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    if (!parsed || typeof parsed !== "object") return undefined;
    const binding = parsed as { scopeId?: unknown; mode?: unknown; executionFenced?: unknown };
    return (binding.mode === "discussion_only" || binding.mode === "shared_ai")
      && binding.executionFenced === true
      ? z.uuid().safeParse(binding.scopeId).data
      : undefined;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[chat/repository] collaboration binding decode failed",
        error instanceof Error ? error.name : "UnknownError");
    }
    return undefined;
  }
}

export async function ownerSharedProjection(
  executor: Executor,
  owner: ChatOwner,
  scopeId: string,
  chatId: string,
): Promise<CanonicalChatCollaboration | undefined> {
  const collaborationExecutor = executor as unknown as Kysely<OwnerCollaborationDatabase>;
  const scope = await collaborationExecutor.selectFrom("collaboration_scopes")
    .select(["id", "parent_scope_id", "membership_mode", "lifecycle", "authority_runtime_id"])
    .where("id", "=", scopeId)
    .where("owner_type", "=", owner.type)
    .where("owner_id", "=", owner.ownerId)
    .where("kind", "=", "chat")
    .where("resource_id", "=", chatId)
    .where("lifecycle", "in", ["shared", "archived", "deleting"])
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!scope) return undefined;

  let membershipScopeId: string;
  if (scope.membership_mode === "direct") {
    if (scope.parent_scope_id !== null) return undefined;
    membershipScopeId = scope.id;
  } else {
    if (!scope.parent_scope_id) return undefined;
    const parent = await collaborationExecutor.selectFrom("collaboration_scopes")
      .select("id")
      .where("id", "=", scope.parent_scope_id)
      .where("owner_type", "=", owner.type)
      .where("owner_id", "=", owner.ownerId)
      .where("kind", "=", "project")
      .where("membership_mode", "=", "direct")
      .where("parent_scope_id", "is", null)
      .where("lifecycle", "=", scope.lifecycle)
      .where("authority_runtime_id", "=", scope.authority_runtime_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!parent) return undefined;
    membershipScopeId = parent.id;
  }

  const ownerMember = await collaborationExecutor.selectFrom("collaboration_members")
    .select("actor_id")
    .where("scope_id", "=", membershipScopeId)
    .where("actor_id", "=", owner.ownerId)
    .where("role", "=", "owner")
    .where("status", "=", "accepted")
    .where((eb) => eb.or([
      eb("expires_at", "is", null),
      eb("expires_at", ">", sql<Date | string>`clock_timestamp()`),
    ]))
    .executeTakeFirst();
  if (!ownerMember) return undefined;
  const members = await collaborationExecutor.selectFrom("collaboration_members")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("scope_id", "=", membershipScopeId)
    .where("status", "=", "accepted")
    .where((eb) => eb.or([
      eb("expires_at", "is", null),
      eb("expires_at", ">", sql<Date | string>`clock_timestamp()`),
    ]))
    .executeTakeFirstOrThrow();
  return { mode: "shared", membership: { role: "owner", memberCount: Number(members.count) } };
}
