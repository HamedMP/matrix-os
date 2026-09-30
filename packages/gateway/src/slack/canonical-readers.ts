import type { Kysely } from "kysely";
import type { ChatDatabase } from "../chat/database.js";
import type { SlackCompanyOptions } from "./company-service.js";
import { SlackCompanyError } from "./schemas.js";

/** Exact canonical queued/run/message reads; requester identity comes from the queue, never Slack text. */
export function createSlackCanonicalReaders(db: Kysely<ChatDatabase>): Pick<SlackCompanyOptions, "readResult" | "findAcceptedRequest"> {
  return {
    async findAcceptedRequest(input) {
      const row = await db.selectFrom("chat_queued_turns as queued").innerJoin("chats as chat","chat.id","queued.chat_id")
        .select(["queued.id","queued.payload_hash"]).where("chat.owner_type","=","personal").where("chat.owner_id","=",input.ownerId)
        .where("queued.chat_id","=",input.chatId).where("queued.collaboration_scope_id","=",input.scopeId)
        .where("queued.requesting_actor_id","=",input.actorId).where("queued.actor_request_id","=",input.clientRequestId).executeTakeFirst();
      return row ? {queuedTurnId:row.id,payloadHash:row.payload_hash} : null;
    },
    async readResult(input) {
      const queued = await db.selectFrom("chat_queued_turns as queued").innerJoin("chats as chat","chat.id","queued.chat_id")
        .selectAll("queued").where("chat.owner_type","=","personal").where("chat.owner_id","=",input.ownerId)
        .where("queued.id","=",input.queuedTurnId).where("queued.chat_id","=",input.chatId).where("queued.collaboration_scope_id","=",input.scopeId).executeTakeFirst();
      if (!queued?.requesting_actor_id) throw new SlackCompanyError("forbidden");
      const requestingActorId=queued.requesting_actor_id;
      if (["cancelled","interrupted","unauthorized","unavailable"].includes(queued.status)) return {status:"failed",requestingActorId};
      if (!queued.claimed_run_id) return {status:"pending",requestingActorId};
      const run = await db.selectFrom("chat_runs").select(["id","status"]).where("id","=",queued.claimed_run_id).where("chat_id","=",input.chatId).executeTakeFirst();
      if (!run) throw new SlackCompanyError("forbidden");
      if (["failed","aborted"].includes(run.status)) return {status:"failed",requestingActorId,runId:run.id};
      if (run.status !== "completed") return {status:"pending",requestingActorId,runId:run.id};
      const messages=await db.selectFrom("chat_messages").select(["parts","byte_count"]).where("chat_id","=",input.chatId).where("run_id","=",run.id)
        .where("role","=","assistant").where("purpose","=","assistant").where("state","=","committed").orderBy("seq","asc").limit(20).execute();
      let text="";
      for (const message of messages) {
        if (message.byte_count>65_536 || text.length>=12_000) break;
        const parts = typeof message.parts === "string" ? JSON.parse(message.parts) : message.parts;
        if (!Array.isArray(parts)) throw new SlackCompanyError("unavailable");
        for (const part of parts.slice(0,64)) if (part && typeof part==="object" && part.type==="text" && typeof part.text==="string") text+=part.text.slice(0,12_000-text.length);
      }
      return {status:"completed",requestingActorId,runId:run.id,text};
    },
  };
}
