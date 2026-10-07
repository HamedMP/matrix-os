import type { Transaction } from "kysely";
import type { AuthorizedCollaborationContext } from "./authority.js";
import type { OwnerCollaborationDatabase } from "./database.js";

export function directSharedChatBindingMatches(
  value: unknown,
  scopeId: string,
  options: { executionFenced?: boolean } = {},
): boolean {
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
    return !!parsed && typeof parsed === "object"
      && (parsed as { scopeId?: unknown }).scopeId === scopeId
      && (options.executionFenced !== true
        || (parsed as { executionFenced?: unknown }).executionFenced === true);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[collaboration-chat] binding decode failed",
        error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
}

export async function authorizedSharedChatBindingMatches(
  trx: Transaction<OwnerCollaborationDatabase>,
  context: AuthorizedCollaborationContext,
  directBinding: unknown,
  options: { executionFenced?: boolean } = {},
): Promise<boolean> {
  if (directSharedChatBindingMatches(directBinding, context.scopeId, options)) return true;
  const inherited = await trx.selectFrom("collaboration_resource_bindings")
    .select("id")
    .where("project_scope_id", "=", context.membershipScopeId)
    .where("resource_scope_id", "=", context.scopeId)
    .where("resource_kind", "=", "chat")
    .where("resource_id", "=", context.resourceId)
    .where("authority_runtime_id", "=", context.authorityRuntimeId)
    .where("authority_generation", "=", context.authorityGeneration)
    .where("readiness", "=", "ready")
    .executeTakeFirst();
  return Boolean(inherited);
}
