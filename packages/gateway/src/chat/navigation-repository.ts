import { chatImportHarnessSql, chatImportSource } from "./import-source.js";
import { CanonicalChatNavigationItemSchema, CanonicalChatNavigationQuerySchema,
  CanonicalChatNavigationPageQuerySchema, CanonicalChatNavigationPageResponseSchema,
  CanonicalChatNavigationResponseSchema, CanonicalOwnerScopeSchema,
  type CanonicalChatNavigationQuery, type CanonicalChatNavigationResponse,
  type CanonicalChatNavigationPageQuery, type CanonicalChatNavigationPageResponse } from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod/v4";
import type { ChatDatabase, ChatsTable } from "./database.js";
import { asIso, parseJson, projectSuccessfulCompletion, type ChatOwner } from "./records.js";
import { projectReadState } from "./read-state-repository.js";

type NavigationRow = Pick<Selectable<ChatsTable>, "id" | "title" | "title_version" | "activity_at" | "archived_at" | "lifecycle" | "attention"
  | "revision" | "message_count" | "user_state" | "project_id" | "bound_driver_kind" | "bound_instance_id"
  | "bound_at_turn_id" | "collaboration" | "created_at" | "updated_at"> & {
  import_harness: "claude" | "codex" | null;
  read_through_seq: number | null; pinned: boolean | null; muted: boolean | null;
  marked_unread: boolean | null; read_state_version: number | null; attention_acknowledged_at: Date | string | null;
  incoming_seq: number | null; run_id: string | null; turn_id: string | null; run_status: string | null;
  completion_run_id: string | null; completed_at: Date | string | null; bot_id: string | null; truncated: boolean;
};

export interface ChatNavigationReader {
  list(owner: ChatOwner, input: CanonicalChatNavigationQuery, ids?: readonly string[]): Promise<CanonicalChatNavigationResponse>;
  page(owner: ChatOwner, input: CanonicalChatNavigationPageQuery): Promise<CanonicalChatNavigationPageResponse>;
}

const NavigationCursorSchema = z.object({
  activityAt: z.iso.datetime({ offset: true }),
  chatId: z.string().min(1).max(200),
}).strict();
function decodeNavigationCursor(value: string) {
  try {
    return NavigationCursorSchema.parse(JSON.parse(Buffer.from(value.slice("navcur_".length), "base64url").toString("utf8")));
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error;
    throw new z.ZodError([{ code: "custom", path: ["cursor"], message: "Invalid cursor" }]);
  }
}
function encodeNavigationCursor(activityAt: string, chatId: string) {
  return `navcur_${Buffer.from(JSON.stringify({ activityAt, chatId })).toString("base64url")}`;
}

/** One statement gives every projection the same MVCC snapshot, with no per-row round trips. */
export function createChatNavigationRepository(db: Kysely<ChatDatabase>): ChatNavigationReader {
  return { async list(ownerInput, queryInput, ids) {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    if (owner.type !== "personal") throw new Error("Navigation requires a personal scope");
    const input = CanonicalChatNavigationQuerySchema.parse(queryInput);
    const lifecycle = sql`AND lifecycle = ${input.lifecycle ?? "active"}`;
    const idFilter = ids ? sql`AND id IN (${sql.join(ids.map(id => sql`${id}`))})` : sql``;
    const result = await sql<NavigationRow>`
      WITH selected AS MATERIALIZED (
        SELECT id,title,title_version,activity_at,archived_at,lifecycle,attention,revision,message_count,user_state,project_id,
          bound_driver_kind,bound_instance_id,bound_at_turn_id,collaboration,created_at,updated_at
        FROM chats WHERE owner_type = ${owner.type} AND owner_id = ${owner.ownerId} ${lifecycle} ${idFilter}
        ORDER BY activity_at DESC,id ASC LIMIT ${input.limit + 1}
      ), page AS MATERIALIZED (
        SELECT * FROM selected ORDER BY activity_at DESC,id ASC LIMIT ${input.limit}
      ), active AS (
        SELECT DISTINCT ON (r.chat_id) r.chat_id,r.id,r.turn_id,r.status
        FROM chat_runs r JOIN page p ON p.id=r.chat_id
        WHERE r.status IN ('accepted','running','waiting_for_approval','waiting_for_input')
        ORDER BY r.chat_id,r.created_at DESC,r.id DESC
      ), completed AS (
        SELECT DISTINCT ON (r.chat_id) r.chat_id,r.id,r.completed_at
        FROM chat_runs r JOIN page p ON p.id=r.chat_id
        WHERE r.status='completed' AND r.outcome='completed' AND r.completed_at IS NOT NULL
        ORDER BY r.chat_id,r.completed_at DESC,r.created_at DESC,r.id DESC
      ), incoming AS (
        SELECT m.chat_id,MAX(m.seq) AS seq FROM chat_messages m JOIN page p ON p.id=m.chat_id
        WHERE m.role='assistant' AND m.state='committed' GROUP BY m.chat_id
      ), bindings AS (
        SELECT DISTINCT ON (b.chat_id) b.chat_id,b.bot_id FROM bot_chat_bindings b JOIN page p ON p.id=b.chat_id
        WHERE b.owner_id=${owner.ownerId} AND b.kind='direct' AND b.removed_at IS NULL
        ORDER BY b.chat_id,b.created_at ASC,b.bot_id ASC
      )
      SELECT p.*,${chatImportHarnessSql(owner, sql.ref<string>("p.id"))} AS import_harness,s.read_through_seq,s.pinned,s.muted,s.marked_unread,s.read_state_version,s.attention_acknowledged_at,
        incoming.seq AS incoming_seq,active.id AS run_id,active.turn_id,active.status AS run_status,
        completed.id AS completion_run_id,completed.completed_at,bindings.bot_id,
        (SELECT COUNT(*) FROM selected) > ${input.limit} AS truncated
      FROM page p LEFT JOIN chat_user_state s ON s.chat_id=p.id AND s.principal_id=${owner.ownerId}
      LEFT JOIN active ON active.chat_id=p.id LEFT JOIN completed ON completed.chat_id=p.id
      LEFT JOIN incoming ON incoming.chat_id=p.id LEFT JOIN bindings ON bindings.chat_id=p.id
      ORDER BY p.activity_at DESC,p.id ASC
    `.execute(db);
    const items = result.rows.map(row => {
      const userState = row.read_through_seq === null ? undefined : {
        readThroughSeq: Number(row.read_through_seq), pinned: row.pinned ?? false, muted: row.muted ?? false,
      };
      const readState = projectReadState(row.read_through_seq === null ? undefined : {
        read_through_seq: row.read_through_seq, marked_unread: row.marked_unread ?? false,
        read_state_version: row.read_state_version ?? 0,
      }, row.incoming_seq);
      const completion = projectSuccessfulCompletion(row.completion_run_id ? {
        id: row.completion_run_id, completed_at: row.completed_at,
      } : undefined, row.attention_acknowledged_at);
      return CanonicalChatNavigationItemSchema.parse({
        ...(row.import_harness ? { importSource: chatImportSource(row.import_harness) } : {}),
        chat: { id: row.id, title: row.title, titleVersion: Number(row.title_version),
          activityAt: asIso(row.activity_at), lifecycle: row.lifecycle,
          ...(row.archived_at ? { archivedAt: asIso(row.archived_at) } : {}), attention: row.attention,
          revision: Number(row.revision), messageCount: Number(row.message_count),
          userState: userState ?? (row.user_state === null ? { readThroughSeq: 0, pinned: false, muted: false } : parseJson(row.user_state)),
          createdAt: asIso(row.created_at), updatedAt: asIso(row.updated_at) },
        ...(row.project_id ? { projectId: row.project_id } : {}),
        ...(row.bound_driver_kind && row.bound_instance_id && row.bound_at_turn_id
          ? { providerBinding: { driverKind: row.bound_driver_kind } } : {}),
        ...(row.run_id ? { activeRun: { runId: row.run_id, turnId: row.turn_id, status: row.run_status } } : {}),
        ...(completion ? { latestSuccessfulCompletion: completion } : {}),
        readState, classification: row.bot_id ? { kind: "bot", agentId: row.bot_id } : { kind: "ordinary" },
        persistence: row.collaboration === null ? "personal" : "membership",
      });
    });
    return CanonicalChatNavigationResponseSchema.parse({ version: 1, items,
      truncated: result.rows[0]?.truncated ?? false });
  }, async page(ownerInput, queryInput) {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    if (owner.type !== "personal") throw new Error("Navigation requires a personal scope");
    const input = CanonicalChatNavigationPageQuerySchema.parse(queryInput);
    const cursor = input.cursor ? decodeNavigationCursor(input.cursor) : undefined;
    const active = sql`EXISTS (SELECT 1 FROM chat_runs ar WHERE ar.chat_id=chats.id
      AND ar.status IN ('accepted','running','waiting_for_approval','waiting_for_input'))`;
    const waiting = sql`EXISTS (SELECT 1 FROM chat_runs wr WHERE wr.chat_id=chats.id
      AND wr.status IN ('waiting_for_approval','waiting_for_input'))`;
    const needsYou = sql`(chats.attention IN ('approval_required','input_required') OR ${waiting}
      OR (chats.attention='failed' AND NOT ${active}))`;
    const groupFilter = input.group === "project"
      ? sql`AND chats.project_id = ${input.projectId!}`
      : input.group === "pinned" ? sql`AND EXISTS (SELECT 1 FROM chat_user_state pus WHERE pus.chat_id=chats.id AND pus.principal_id=${owner.ownerId} AND pus.pinned=true)`
      : input.group === "needsYou" ? sql`AND ${needsYou}`
        : input.group === "working" ? sql`AND NOT ${needsYou} AND ${active}`
          : sql`AND NOT ${needsYou} AND NOT ${active}`;
    const pinnedFilter = input.group === "project" || input.group === "pinned" ? sql`` : sql`AND NOT EXISTS (
      SELECT 1 FROM chat_user_state us WHERE us.chat_id=chats.id
        AND us.principal_id=${owner.ownerId} AND us.pinned=true)`;
    const filter = sql`chats.owner_type=${owner.type} AND chats.owner_id=${owner.ownerId}
      AND chats.lifecycle='active' ${groupFilter} ${pinnedFilter}
      AND NOT EXISTS (SELECT 1 FROM bot_chat_bindings b WHERE b.chat_id=chats.id
        AND b.owner_id=${owner.ownerId} AND b.kind='direct' AND b.removed_at IS NULL)`;
    const cursorFilter = cursor ? sql`AND (chats.activity_at < ${cursor.activityAt}::timestamptz
      OR (chats.activity_at = ${cursor.activityAt}::timestamptz AND chats.id > ${cursor.chatId}))` : sql``;
    const [countResult, pageResult] = await Promise.all([
      sql<{ total_count: number }>`SELECT COUNT(*)::int AS total_count FROM chats WHERE ${filter}`.execute(db),
      sql<{ id: string; cursor_activity_at: string }>`SELECT chats.id,
        to_char(chats.activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_activity_at
        FROM chats WHERE ${filter} ${cursorFilter}
        ORDER BY chats.activity_at DESC,chats.id ASC LIMIT ${input.limit + 1}`.execute(db),
    ]);
    const rows = pageResult.rows.slice(0, input.limit);
    const snapshot = rows.length ? await this.list(owner, { version: 1, limit: rows.length }, rows.map(row => row.id))
      : { version: 1 as const, items: [], truncated: false };
    const last = pageResult.rows.length > input.limit ? rows.at(-1) : undefined;
    return CanonicalChatNavigationPageResponseSchema.parse({
      items: snapshot.items,
      totalCount: Number(countResult.rows[0]?.total_count ?? 0),
      ...(last ? { nextCursor: encodeNavigationCursor(last.cursor_activity_at, last.id) } : {}),
    });
  } };
}
