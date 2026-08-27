import {
  CanonicalChatIdSchema,
  CanonicalOwnerScopeSchema,
  type CanonicalChatMessage,
  type CanonicalChatRun,
  type CanonicalChatRunActivity,
  type CanonicalChatTurn,
} from "@matrix-os/contracts";
import type { Kysely } from "kysely";
import type { ChatDatabase } from "./database.js";
import {
  toActivity,
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
      .orderBy("created_at", "desc")
      .limit(100)
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
      .orderBy("receive_seq", "desc")
      .limit(500)
      .execute();
    activityRows.reverse();
    return {
      record,
      messages: selectedMessageRows.map(toMessage),
      turns: turnRows.map(toTurn),
      runs: runRows.map(toRun),
      activities: activityRows.map(toActivity),
      ...(hasOlder && selectedMessageRows[0]
        ? { nextBeforeSeq: Number(selectedMessageRows[0].seq) }
        : {}),
    };
  }
}
