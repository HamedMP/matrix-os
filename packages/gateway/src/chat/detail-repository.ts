import {
  CanonicalChatIdSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatMessage,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
  type CanonicalChatQueuedTurn,
  type CanonicalChatTurn,
} from "@matrix-os/contracts";
import { sql, type Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";
import { toQueuedTurn } from "./queue-repository.js";
import {
  toActivities,
  toMessage,
  toRun,
  toTurn,
  type ChatOwner,
  type ChatRecord,
} from "./records.js";

export interface ChatDetailPage {
  record: ChatRecord;
  messages: CanonicalChatMessage[];
  turns: CanonicalChatTurn[];
  runs: CanonicalChatRun[];
  activities: CanonicalChatRunActivity[];
  queuedTurns: CanonicalChatQueuedTurn[];
  terminalSessionIds: string[];
  nextBeforeSeq?: number;
}

export class ChatDetailRepository {
  constructor(
    private readonly kysely: Kysely<ChatDatabase>,
    private readonly getRecord: (owner: ChatOwner, chatId: string) => Promise<ChatRecord | null>,
  ) {}

  async getDetailPage(ownerInput: ChatOwner, chatId: string, input: {
    beforeSeq?: number;
    limit: number;
  }): Promise<ChatDetailPage | null> {
    const owner = CanonicalOwnerScopeSchema.parse(ownerInput);
    const parsedChatId = CanonicalChatIdSchema.parse(chatId);
    const record = await this.getRecord(owner, parsedChatId);
    if (!record) return null;
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit)));
    const beforeSeq = input.beforeSeq === undefined
      ? Number.MAX_SAFE_INTEGER
      : Math.max(1, Math.trunc(input.beforeSeq));
    const messageRows = await this.kysely.selectFrom("chat_messages").selectAll()
      .where("chat_id", "=", parsedChatId)
      .where("seq", "<", beforeSeq)
      .orderBy("seq", "desc")
      .limit(limit + 1)
      .execute();
    const hasOlder = messageRows.length > limit;
    const selectedMessageRows = messageRows.slice(0, limit).reverse();
    const turnIds = [...new Set(selectedMessageRows.flatMap((row) => row.turn_id ? [row.turn_id] : []))];
    const turnRows = turnIds.length === 0 ? [] : await this.kysely.selectFrom("chat_turns").selectAll()
      .where("chat_id", "=", parsedChatId)
      .where("id", "in", turnIds)
      .orderBy("base_message_seq", "desc")
      .limit(limit)
      .execute();
    turnRows.reverse();
    const selectedRunIds = selectedMessageRows.flatMap((row) => row.run_id ? [row.run_id] : []);
    const runTurnIds = turnRows.map((row) => row.id);
    const runRows = runTurnIds.length === 0 && selectedRunIds.length === 0 ? [] : await this.kysely
      .selectFrom("chat_runs")
      .selectAll()
      .where("chat_id", "=", parsedChatId)
      .where(({ eb, or }) => or([
        ...(runTurnIds.length > 0 ? [eb("turn_id", "in", runTurnIds)] : []),
        ...(selectedRunIds.length > 0 ? [eb("id", "in", selectedRunIds)] : []),
      ]))
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    runRows.reverse();
    const runIds = runRows.map((row) => row.id);
    const activityRows = runIds.length === 0 ? [] : await this.kysely.selectFrom("chat_run_events").selectAll()
      .where("chat_id", "=", parsedChatId)
      .where("run_id", "in", runIds)
      .orderBy("occurred_at", "desc")
      .orderBy("run_id", "desc")
      .orderBy("run_seq", "desc")
      .orderBy("id", "desc")
      .limit(500)
      .execute();
    // A running agent can emit more than 500 later events while waiting for a
    // human answer. Keep actionable requests in the bounded detail response.
    const activeRunIds = runRows.filter((row) => ["accepted", "running", "waiting_for_input", "waiting_for_approval"].includes(row.status))
      .map((row) => row.id);
    const pendingRows = activeRunIds.length === 0 ? [] : await this.kysely.selectFrom("chat_run_events as controls")
      .selectAll("controls")
      .where("controls.chat_id", "=", parsedChatId)
      .where("controls.run_id", "in", activeRunIds)
      .where(sql<string>`controls.event ->> 'type'`, "in", ["input.requested", "approval.requested"])
      .where(sql<boolean>`NOT EXISTS (
        SELECT 1 FROM chat_run_events newer
        WHERE newer.run_id = controls.run_id AND newer.run_seq > controls.run_seq
          AND (newer.event ->> 'type') = (controls.event ->> 'type')
          AND COALESCE(newer.event ->> 'requestId', newer.event ->> 'approvalId')
            = COALESCE(controls.event ->> 'requestId', controls.event ->> 'approvalId')
      )`)
      .where(sql<boolean>`(
        ((controls.event ->> 'type') = 'input.requested'
          AND NOT EXISTS (SELECT 1 FROM chat_run_events resolved
            WHERE resolved.run_id = controls.run_id AND (resolved.event ->> 'type') = 'input.resolved'
              AND (resolved.event ->> 'requestId') = (controls.event ->> 'requestId'))
          AND NOT EXISTS (SELECT 1 FROM chat_run_events submitted
            WHERE submitted.run_id = controls.run_id AND submitted.run_seq > controls.run_seq
              AND (submitted.event ->> 'type') = 'input.submitted'
              AND (submitted.event ->> 'requestId') = (controls.event ->> 'requestId')))
        OR ((controls.event ->> 'type') = 'approval.requested'
          AND NOT EXISTS (SELECT 1 FROM chat_approval_outcomes outcomes
            WHERE outcomes.run_id = controls.run_id
              AND outcomes.approval_id = (controls.event ->> 'approvalId'))
          AND NOT EXISTS (SELECT 1 FROM chat_run_events resolved
            WHERE resolved.run_id = controls.run_id AND (resolved.event ->> 'type') = 'approval.resolved'
              AND (resolved.event ->> 'approvalId') = (controls.event ->> 'approvalId')))
      )`)
      .orderBy("controls.occurred_at", "asc")
      .orderBy("controls.run_id", "asc")
      .orderBy("controls.run_seq", "asc")
      .limit(500)
      .execute();
    const selectedActivities = new Map(pendingRows.map((row) => [row.id, row]));
    for (const row of activityRows) {
      if (selectedActivities.size >= 500) break;
      selectedActivities.set(row.id, row);
    }
    const boundedActivityRows = [...selectedActivities.values()].sort((left, right) =>
      new Date(left.occurred_at).getTime() - new Date(right.occurred_at).getTime()
      || left.run_id.localeCompare(right.run_id)
      || Number(left.run_seq) - Number(right.run_seq)
      || left.id.localeCompare(right.id));
    const terminalBindings = await this.kysely.selectFrom("chat_terminal_bindings")
      .select("session_id")
      .where("chat_id", "=", parsedChatId)
      .orderBy("bound_at", "desc")
      .limit(100)
      .execute();
    const queuedTurnRows = await this.kysely.selectFrom("chat_queued_turns").selectAll()
      .where("chat_id", "=", parsedChatId)
      .where("status", "=", "queued")
      .orderBy("position")
      .limit(20)
      .execute();
    return {
      record,
      messages: selectedMessageRows.map(toMessage),
      turns: turnRows.map(toTurn),
      runs: runRows.map(toRun),
      activities: toActivities(boundedActivityRows),
      queuedTurns: queuedTurnRows.map(toQueuedTurn),
      terminalSessionIds: terminalBindings.reverse().map((binding) => binding.session_id),
      ...(hasOlder && selectedMessageRows[0]
        ? { nextBeforeSeq: Number(selectedMessageRows[0].seq) }
        : {}),
    };
  }
}
