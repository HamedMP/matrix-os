import {
  CanonicalChatExecutionRootRefSchema,
  CanonicalChatIdSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatTurnChangeSetSchema,
  CanonicalChatTurnIdSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatExecutionRootRef,
  type CanonicalChatTurnChangeSet,
} from "@matrix-os/contracts";
import { type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase, ChatTurnChangeSetsTable } from "./database.js";
import { ChatConflictError, ChatNotFoundError } from "./errors.js";
import { jsonb, parseJson, type ChatOwner } from "./records.js";

type Executor = Kysely<ChatDatabase> | Transaction<ChatDatabase>;
type Transact = <T>(fn: (trx: Executor) => Promise<T>) => Promise<T>;
const GitObjectIdSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);

export interface ChatTurnChangeStartInput {
  chatId: string;
  turnId: string;
  runId: string;
  projectId: string;
  executionRoot: CanonicalChatExecutionRootRef;
  executionRootFingerprint: string;
  beforeTree: string;
  beforeHead: string;
  capturedAt: string;
}

export interface ChatTurnChangeRecord {
  changes: CanonicalChatTurnChangeSet;
  executionRootFingerprint: string;
  beforeTree: string;
  beforeHead: string;
  afterTree: string;
  afterHead: string;
}

export async function recordTurnChangeStartInTransaction(
  trx: Executor,
  ownerInput: ChatOwner,
  input: ChatTurnChangeStartInput,
): Promise<void> {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  const parsed = {
    chatId: CanonicalChatIdSchema.parse(input.chatId),
    turnId: CanonicalChatTurnIdSchema.parse(input.turnId),
    runId: CanonicalChatRunIdSchema.parse(input.runId),
    projectId: z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).parse(input.projectId),
    executionRoot: CanonicalChatExecutionRootRefSchema.parse(input.executionRoot),
    executionRootFingerprint: FingerprintSchema.parse(input.executionRootFingerprint),
    beforeTree: GitObjectIdSchema.parse(input.beforeTree),
    beforeHead: GitObjectIdSchema.parse(input.beforeHead),
    capturedAt: new Date(input.capturedAt).toISOString(),
  };
  const run = await trx.selectFrom("chat_runs")
    .innerJoin("chats", "chats.id", "chat_runs.chat_id")
    .select([
      "chat_runs.id", "chat_runs.turn_id", "chat_runs.execution_root",
      "chat_runs.execution_root_fingerprint", "chats.project_id",
    ])
    .where("chat_runs.id", "=", parsed.runId)
    .where("chat_runs.chat_id", "=", parsed.chatId)
    .where("chats.owner_type", "=", owner.type)
    .where("chats.owner_id", "=", owner.ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (!run) throw new ChatNotFoundError(parsed.chatId);
  if (run.turn_id !== parsed.turnId || run.project_id !== parsed.projectId
    || run.execution_root_fingerprint !== parsed.executionRootFingerprint
    || !sameJson(parseJson(run.execution_root), parsed.executionRoot)) {
    throw new ChatConflictError(parsed.chatId, 0);
  }
  await trx.insertInto("chat_turn_change_sets").values({
    run_id: parsed.runId,
    chat_id: parsed.chatId,
    turn_id: parsed.turnId,
    project_id: parsed.projectId,
    execution_root: jsonb(parsed.executionRoot),
    execution_root_fingerprint: parsed.executionRootFingerprint,
    before_tree: parsed.beforeTree,
    before_head: parsed.beforeHead,
    after_tree: null,
    after_head: null,
    status: "capturing",
    change_set: null,
    byte_count: 0,
    captured_at: parsed.capturedAt,
    updated_at: parsed.capturedAt,
  }).onConflict((conflict) => conflict.column("run_id").doNothing()).execute();
  const stored = await trx.selectFrom("chat_turn_change_sets").selectAll()
    .where("run_id", "=", parsed.runId).executeTakeFirstOrThrow();
  if (stored.chat_id !== parsed.chatId || stored.turn_id !== parsed.turnId || stored.project_id !== parsed.projectId
    || stored.before_tree !== parsed.beforeTree || stored.before_head !== parsed.beforeHead
    || stored.execution_root_fingerprint !== parsed.executionRootFingerprint
    || !sameJson(parseJson(stored.execution_root), parsed.executionRoot)) {
    throw new ChatConflictError(parsed.chatId, 0);
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseSettled(row: Selectable<ChatTurnChangeSetsTable>): ChatTurnChangeRecord | null {
  if (row.status !== "settled" || row.change_set === null || row.after_tree === null || row.after_head === null) return null;
  return {
    changes: CanonicalChatTurnChangeSetSchema.parse(parseJson(row.change_set)),
    executionRootFingerprint: row.execution_root_fingerprint,
    beforeTree: row.before_tree,
    beforeHead: row.before_head,
    afterTree: row.after_tree,
    afterHead: row.after_head,
  };
}

export async function settleTurnChangesInTransaction(
  trx: Executor,
  ownerInput: ChatOwner,
  input: {
    chatId: string;
    runId: string;
    changes: CanonicalChatTurnChangeSet;
    afterTree: string;
    afterHead: string;
  },
): Promise<void> {
  const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
  const changes = CanonicalChatTurnChangeSetSchema.parse(input.changes);
  const afterTree = GitObjectIdSchema.parse(input.afterTree);
  const afterHead = GitObjectIdSchema.parse(input.afterHead);
  const row = await trx.selectFrom("chat_turn_change_sets")
    .innerJoin("chats", "chats.id", "chat_turn_change_sets.chat_id")
    .selectAll("chat_turn_change_sets")
    .where("chat_turn_change_sets.run_id", "=", CanonicalChatRunIdSchema.parse(input.runId))
    .where("chat_turn_change_sets.chat_id", "=", CanonicalChatIdSchema.parse(input.chatId))
    .where("chats.owner_type", "=", owner.type)
    .where("chats.owner_id", "=", owner.ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new ChatNotFoundError(input.chatId);
  if (changes.chatId !== row.chat_id || changes.turnId !== row.turn_id || changes.runId !== row.run_id
    || changes.projectId !== row.project_id || changes.beforeRevision !== `tree_${row.before_tree}`
    || changes.afterRevision !== `tree_${afterTree}` || !sameJson(changes.executionRoot, parseJson(row.execution_root))) {
    throw new ChatConflictError(input.chatId, 0);
  }
  const byteCount = Buffer.byteLength(JSON.stringify(changes), "utf8");
  if (byteCount > 512 * 1024) throw new ChatConflictError(input.chatId, 0);
  if (row.status === "settled") {
    const existing = parseSettled(row);
    if (!existing || !sameJson(existing.changes, changes) || existing.afterTree !== afterTree || existing.afterHead !== afterHead) {
      throw new ChatConflictError(input.chatId, 0);
    }
    return;
  }
  await trx.updateTable("chat_turn_change_sets").set({
    after_tree: afterTree,
    after_head: afterHead,
    status: "settled",
    change_set: jsonb(changes),
    byte_count: byteCount,
    updated_at: changes.capturedAt,
  }).where("run_id", "=", row.run_id).where("status", "=", "capturing").executeTakeFirstOrThrow();
}

export class ChatTurnChangeRepository {
  constructor(private readonly kysely: Kysely<ChatDatabase>, private readonly transact: Transact) {}

  async recordStart(ownerInput: ChatOwner, input: ChatTurnChangeStartInput): Promise<void> {
    await this.transact((trx) => recordTurnChangeStartInTransaction(trx, ownerInput, input));
  }

  async get(ownerInput: ChatOwner, chatId: string, turnId: string): Promise<ChatTurnChangeRecord | null> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const row = await this.kysely.selectFrom("chat_turn_change_sets")
      .innerJoin("chats", "chats.id", "chat_turn_change_sets.chat_id")
      .innerJoin("chat_runs", "chat_runs.id", "chat_turn_change_sets.run_id")
      .selectAll("chat_turn_change_sets")
      .where("chat_turn_change_sets.chat_id", "=", CanonicalChatIdSchema.parse(chatId))
      .where("chat_turn_change_sets.turn_id", "=", CanonicalChatTurnIdSchema.parse(turnId))
      .where("chats.owner_type", "=", owner.type)
      .where("chats.owner_id", "=", owner.ownerId)
      .orderBy("chat_runs.attempt", "desc")
      .executeTakeFirst();
    return row ? parseSettled(row) : null;
  }
}
