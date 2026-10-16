import { CanonicalChatNavigationItemSchema, CanonicalChatNavigationQuerySchema,
  CanonicalChatNavigationResponseSchema, CanonicalOwnerScopeSchema,
  type CanonicalChatNavigationQuery, type CanonicalChatNavigationResponse } from "@matrix-os/contracts";
import { sql, type Kysely, type Selectable } from "kysely";
import type { ChatDatabase, ChatsTable } from "./database.js";
import { asIso, parseJson, projectSuccessfulCompletion, type ChatOwner } from "./records.js";
import { projectReadState } from "./read-state-repository.js";

type NavigationRow = Pick<Selectable<ChatsTable>, "id" | "title" | "title_version" | "activity_at" | "lifecycle" | "attention"
  | "revision" | "message_count" | "user_state" | "project_id" | "bound_driver_kind" | "bound_instance_id"
  | "bound_at_turn_id" | "collaboration" | "created_at" | "updated_at"> & {
  read_through_seq: number | null; pinned: boolean | null; muted: boolean | null;
  marked_unread: boolean | null; read_state_version: number | null; attention_acknowledged_at: Date | string | null;
  incoming_seq: number | null; run_id: string | null; turn_id: string | null; run_status: string | null;
  completion_run_id: string | null; completed_at: Date | string | null; bot_id: string | null; truncated: boolean;
};

export interface ChatNavigationReader {
  list(owner: ChatOwner, input: CanonicalChatNavigationQuery): Promise<CanonicalChatNavigationResponse>;
}

/** One statement gives every projection the same MVCC snapshot, with no per-row round trips. */
export function createChatNavigationRepository(db: Kysely<ChatDatabase>): ChatNavigationReader {
  return { async list(ownerInput, queryInput) {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    if (owner.type !== "personal") throw new Error("Navigation requires a personal scope");
    const input = CanonicalChatNavigationQuerySchema.parse(queryInput);
    const lifecycle = input.lifecycle ? sql`AND lifecycle = ${input.lifecycle}` : sql``;
    const result = await sql<NavigationRow>`
      WITH selected AS MATERIALIZED (
        SELECT id,title,title_version,activity_at,lifecycle,attention,revision,message_count,user_state,project_id,
          bound_driver_kind,bound_instance_id,bound_at_turn_id,collaboration,created_at,updated_at
        FROM chats WHERE owner_type = ${owner.type} AND owner_id = ${owner.ownerId} ${lifecycle}
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
        WHERE b.owner_id=${owner.ownerId} AND b.kind IN ('direct','thread') AND b.removed_at IS NULL
        ORDER BY b.chat_id,b.created_at ASC,b.bot_id ASC
      )
      SELECT p.*,s.read_through_seq,s.pinned,s.muted,s.marked_unread,s.read_state_version,s.attention_acknowledged_at,
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
        chat: { id: row.id, title: row.title, titleVersion: Number(row.title_version),
          activityAt: asIso(row.activity_at), lifecycle: row.lifecycle, attention: row.attention,
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
  } };
}
