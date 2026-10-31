import { afterEach, expect, it } from "vitest";
import { Kysely } from "kysely";
import type { ChatDatabase } from "../../../packages/gateway/src/chat/database.js";
import { ChatRepository } from "../../../packages/gateway/src/chat/repository.js";
import { createBotStateTransactions } from "../../../packages/gateway/src/bots/events.js";
import { createBotTasksRepository } from "../../../packages/gateway/src/bots/repositories/tasks.js";
import { beginBotTask } from "../../../packages/gateway/src/bots/task-begin.js";
import { BOT,OWNER,NOW,createBotStateDatabase,insertChat } from "./bot-state-support.js";
let data: Awaited<ReturnType<typeof createBotStateDatabase>>|undefined;
afterEach(async()=>{await data?.destroy();data=undefined;});
async function fixture(){data=await createBotStateDatabase();await insertChat(data.db,"chat_bg_begin");
 return {db:data.db,tasks:createBotTasksRepository(data.db),transact:createBotStateTransactions(new ChatRepository(data.db as unknown as Kysely<ChatDatabase>))};}
it("starts the claimed background task instead of continuing an unrelated waiting foreground task",async()=>{
 const f=await fixture();const claimed=await f.tasks.create({ownerId:OWNER,botId:BOT,chatId:"chat_bg_begin",now:NOW});
 const foreground=await f.tasks.create({ownerId:OWNER,botId:BOT,chatId:"chat_bg_begin",now:NOW});
 await f.tasks.transition({ownerId:OWNER,taskId:foreground.taskId,baseRevision:1,to:"running",runId:"run_foreground",now:NOW});
 await f.tasks.transition({ownerId:OWNER,taskId:foreground.taskId,baseRevision:2,to:"waiting_person",now:NOW});
 const result=await f.transact(OWNER,tx=>beginBotTask(tx,{ownerId:OWNER,botId:BOT,chatId:"chat_bg_begin",runId:"run_bg_claim",text:"synthetic",now:NOW,backgroundTaskId:claimed.taskId}));
 expect(result.task.taskId).toBe(claimed.taskId);expect(result.task.runId).toBe("run_bg_claim");expect(result.continued).toBe(false);
 expect(await f.tasks.get({ownerId:OWNER,taskId:foreground.taskId})).toMatchObject({status:"waiting_person",runId:"run_foreground"});
});
it("refuses mismatched background ownership without creating another task",async()=>{
 const f=await fixture();const claimed=await f.tasks.create({ownerId:OWNER,botId:BOT,chatId:"chat_bg_begin",now:NOW});
 await expect(f.transact(OWNER,tx=>beginBotTask(tx,{ownerId:OWNER,botId:"bot_other12345678",chatId:"chat_bg_begin",runId:"run_bg_claim",text:"synthetic",now:NOW,backgroundTaskId:claimed.taskId}))).rejects.toMatchObject({code:"conflict"});
 expect(await f.tasks.get({ownerId:OWNER,taskId:claimed.taskId})).toMatchObject({status:"queued",runId:null,revision:1});
});
