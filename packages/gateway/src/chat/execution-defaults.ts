/**
 * A Chat's default execution root: the worktree its turns run in when a turn
 * names no root (spec 2699 section 3, "Start work"). The board sets it once
 * when it creates a task chat; clients never supply it. Without a row, turns
 * fall back to the Chat's Project folder as before.
 *
 * The row records the Project it was made for. It applies only while the Chat
 * still belongs to that Project, so moving the Chat drops the default without
 * another write.
 */
import { sql, type Kysely, type QueryExecutorProvider } from "kysely";
import {
  CanonicalChatIdSchema, WorktreeIdSchema,
  type CanonicalChatExecutionRootRef, type CanonicalProviderSupport,
} from "@matrix-os/contracts";
import type { ChatDatabase } from "./database.js";
import type { ChatOwner, ChatRecord } from "./records.js";

/** Additive schema only; the repository remains the sole pool owner. */
export async function bootstrapChatExecutionDefaults<Database extends ChatDatabase>(db: Kysely<Database>): Promise<void> {
  await db.transaction().execute(async (trx) => {
    await sql`SET LOCAL lock_timeout = '5s'`.execute(trx);
    await sql`SET LOCAL statement_timeout = '5s'`.execute(trx);
    await sql`SELECT pg_advisory_xact_lock(hashtext(current_schema()), hashtext('chat_execution_defaults'))`.execute(trx);
    await sql`CREATE TABLE IF NOT EXISTS chat_execution_defaults (
      chat_id TEXT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      worktree_id TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`.execute(trx);
  });
}

/**
 * Bind the Chat's default worktree. Runs inside the caller's transaction; the
 * statement only writes when the owner's Chat exists and belongs to `projectId`.
 */
export async function writeChatExecutionDefault(
  db: QueryExecutorProvider, owner: ChatOwner, chatId: string, input: { projectId: string; worktreeId: string },
): Promise<void> {
  CanonicalChatIdSchema.parse(chatId);
  const worktreeId = WorktreeIdSchema.parse(input.worktreeId);
  await sql`INSERT INTO chat_execution_defaults (chat_id, project_id, worktree_id)
    SELECT chats.id, chats.project_id, ${worktreeId}
    FROM chats
    WHERE chats.id = ${chatId} AND chats.owner_type = ${owner.type} AND chats.owner_id = ${owner.ownerId}
      AND chats.project_id = ${input.projectId}
    ON CONFLICT (chat_id) DO UPDATE
      SET project_id = EXCLUDED.project_id, worktree_id = EXCLUDED.worktree_id, updated_at = now()`.execute(db);
}

/** The owner's Chat default worktree, or null when none applies to its current Project. */
export async function readChatExecutionDefault(
  db: QueryExecutorProvider, owner: ChatOwner, chatId: string,
): Promise<{ projectId: string; worktreeId: string } | null> {
  const result = await sql<{ project_id: string; worktree_id: string }>`
    SELECT defaults.project_id, defaults.worktree_id
    FROM chat_execution_defaults AS defaults
    JOIN chats ON chats.id = defaults.chat_id AND chats.project_id = defaults.project_id
    WHERE defaults.chat_id = ${chatId} AND chats.owner_type = ${owner.type} AND chats.owner_id = ${owner.ownerId}
    LIMIT 1`.execute(db);
  const row = result.rows[0];
  if (!row || !WorktreeIdSchema.safeParse(row.worktree_id).success) return null;
  return { projectId: row.project_id, worktreeId: row.worktree_id };
}

/**
 * The root for a turn that names none: the Chat's default worktree when the
 * Provider runs in worktrees, otherwise the Chat's Project folder.
 */
export function chatDefaultExecutionRoot(
  record: Pick<ChatRecord, "projectId">,
  executionDefault: { projectId: string; worktreeId: string } | null | undefined,
  supports: Pick<CanonicalProviderSupport, "worktrees">,
): CanonicalChatExecutionRootRef | undefined {
  if (!record.projectId) return undefined;
  if (executionDefault && executionDefault.projectId === record.projectId && supports.worktrees !== "none") {
    return { kind: "worktree", projectId: record.projectId, worktreeId: executionDefault.worktreeId };
  }
  return { kind: "project", projectId: record.projectId };
}
