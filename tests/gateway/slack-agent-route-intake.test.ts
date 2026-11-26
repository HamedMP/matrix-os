import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatAgentStore } from "../../packages/gateway/src/chat/agent-store.js";
import type { ChatDatabase } from "../../packages/gateway/src/chat/database.js";
import { bootstrapChatSharing } from "../../packages/gateway/src/chat/sharing.js";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import { expect, it, vi } from "vitest";
import { createBotIntegrationClient } from "../../packages/gateway/src/bots/integration-client.js";
import { createBotStateTransactions } from "../../packages/gateway/src/bots/events.js";
import { createBotResourceCandidates } from "../../packages/gateway/src/bots/resource-grant-candidates.js";
import { createBotResourceGrantService } from "../../packages/gateway/src/bots/resource-grant-service.js";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createSlackMentionSummaries } from "../../packages/gateway/src/slack/mention-summary.js";
import { createSlackAgentRouteLane } from "../../packages/gateway/src/startup/slack-agent-route-lane.js";
import { createSlackOwnerClient } from "../../packages/gateway/src/startup/slack-owner-client.js";
import { registerOwnerSlack } from "../../packages/gateway/src/startup/slack-owner.js";
import { createSlackHomeTransport } from "../../packages/platform/src/slack-home-transport.js";
import { createSlackApp } from "../../packages/platform/src/slack/wiring.js";
import { encryptSlackToken } from "../../packages/platform/src/slack/security.js";
import type { SlackDatabase } from "../../packages/platform/src/slack/database.js";
import { createRealBotStateDatabase, insertChat } from "./bots/bot-state-support.js";

it("reopens two Apps assignments and matches signed events from one installation to their original private Chats", async () => {
  const fixture = await createRealBotStateDatabase();
  const { db } = fixture;
  const close: Array<() => Promise<unknown> | void> = [fixture.destroy];
  try {
    const chatDb = db as unknown as Kysely<ChatDatabase>;
    const home = await mkdtemp(join(tmpdir(),"eng85-routed-intake-"));
    close.push(() => rm(home, { recursive:true, force:true }));
    const store = new ChatAgentStore({db:chatDb,homePath:home});
    await store.bootstrap();
    close.push(() => store.close());
    await bootstrapChatSharing(chatDb);
    const ownerId = "user_intake", organizationId = "org_intake", handle = "intake-dev", token = "a".repeat(64);
    const appId = "A123", teamId = "T123", senderId = "U123", machineId = "6c949f52-99a8-42eb-8a15-11bb1a045cc6";
    const dev = {ownerId,organizationId,handle,machineId,teamId,channelId:"C999",ownerSlackId:senderId};
    const channels = [{channelId:"C101",name:"summary",senderId},{channelId:"C102",name:"reviews",senderId}];
    const agents = ["bot_1234567812345678","bot_abcdef0123456789"];
    const chats = ["chat_intake_summary","chat_intake_review"];
    const config = { appId, clientId:"123.456", clientSecret:"c".repeat(32), signingSecret:"s".repeat(32),
      tokenEncryptionKey:Buffer.alloc(32,42).toString("base64"), publicBaseUrl:"https://platform.example" };
    const api = {conversationInfo:vi.fn(async ({channelId}:{channelId:string}) => ({canAccess:true,isExternalShared:false,
      channelMetadata:{id:channelId,name:channels.find(c=>c.channelId===channelId)?.name}})),
      hasChannelMember:vi.fn(async()=>true),replies:vi.fn(),postMessage:vi.fn(),addReaction:vi.fn(),history:vi.fn(),exchangeCode:vi.fn()};
    const gateway = new Hono();
    const sendHome = createSlackHomeTransport({fetchImpl:async(url,init)=>gateway.fetch(new Request(url,init))});
    const platform = await createSlackApp({db:db as unknown as Kysely<SlackDatabase>,config,api,startCleanup:false,
      readOnlyDev:dev,agentChannels:{teamId,ownerSlackId:senderId,channels},resolveActor:async()=>null,requireOrgAdmin:async()=>false,
      isCurrentMember:async()=>true,authorizeChannelBinding:async()=>false,authorizeReply:async()=>false,
      resolveDestination:async()=>({ownerId,runtimeId:machineId}), authenticateRuntime:async()=>({ownerId,runtimeId:machineId}),
      dispatch:vi.fn(),dispatchRouted:async(event,signal)=>{await sendHome({ownerId,token,origin:"https://gateway.example"},"agent-event",event,signal);} });
    close.push(platform.close);
    await platform.repository.saveInstallation({appId,teamId,organizationId,installedBy:ownerId,botUserId:"UBOT",
      encryptedBotToken:encryptSlackToken("xoxb-fixture",config.tokenEncryptionKey,appId+":"+teamId)});
    await platform.repository.createChallenge({hash:"f".repeat(64),appId,teamId,slackUserId:senderId});
    await platform.repository.completeLink({hash:"f".repeat(64),actorId:ownerId,organizationId});
    const target = {...dev, appId, botId:"bot_11111111",chatId:"chat_pilot",agentRoutes:true as const};
    const connection={handle,token,platformUrl:config.publicBaseUrl,machineId,runtimeSlot:"dev",devTarget:target};
    const slack=createSlackOwnerClient({...connection,fetchImpl:async(url,init)=>platform.routes.fetch(new Request(url,init))});
    const transact=createBotStateTransactions(new ChatRepository(chatDb));
    const isActiveManagedAgent=async(o:string,b:string)=>o===ownerId && agents.includes(b);
    const repo={repositoryId:"123",fullName:"acme/demo"};
    const github=createBotIntegrationClient(async(_,r)=>Response.json(r.path==="/"?[{id:"gh_fixture",service:"github",account_label:"owner",status:"active"}]
      :{data:[{id:123,full_name:"acme/demo",permissions:{pull:true}}]}));
    const lane=createSlackAgentRouteLane({platform:connection,ownerId,computerId:handle,repository:repo,transact,isActiveManagedAgent,github,listChannels:slack.listAgentRouteChannels})!;
    const worker=await createSlackMentionSummaries({db,ownerId,runtimeId:machineId,authorize:async()=>false,readThread:async()=>null,routed:lane.worker});
    close.push(worker.close);
    const bridge=registerOwnerSlack({app:gateway,ownerId,token,devTarget:target,summaries:worker,startDrain:false,authority:{authorize:vi.fn()}});
    close.push(bridge.close);
    const openApps=()=>createBotResourceGrantService({transact,isActiveManagedAgent,providers:createBotResourceCandidates({
      runtimeOwnerId:ownerId,client:github,githubReview:repo,slackRouteChannels:lane.listChannels})});
    for (const [i,id] of agents.entries()) {
      await insertChat(db,chats[i]!,ownerId);
      await db.insertInto("bot_chat_bindings").values({owner_id:ownerId,chat_id:chats[i]!,bot_id:id,kind:"direct",created_at:new Date(),removed_at:null}).execute();
      const apps=openApps();
      if(i===1) await apps.grant(ownerId,id,(await apps.list(ownerId,id)).candidates.find(c=>c.kind==="github_repository")!.id);
      const c=(await apps.list(ownerId,id)).candidates.find(c=>c.routeKind===(i===0?"summary":"review") && c.label.includes("#"+channels[i]!.name));
      expect(c).toBeDefined();
      await apps.grant(ownerId,id,c!.id);
      expect((await openApps().list(ownerId,id)).grants).toHaveLength(i+1);
    }
    const eventSeconds = Math.floor(Date.now() / 1000) + 1;
    async function push(i:number,text:string, sequence = i + 1){
      const ts = eventSeconds + "." + String(sequence).padStart(6, "0");
      const body=JSON.stringify({type:"event_callback",api_app_id:appId,team_id:teamId,event_id:"EvRoute" + sequence,
        event:{type:"message",channel_type:"channel",channel:channels[i]!.channelId,user:senderId,ts,text}});
      const timestamp=String(Math.floor(Date.now()/1000));
      const signature=createHmac("sha256",config.signingSecret).update("v0:"+timestamp+":"+body).digest("hex");
      return platform.routes.request("/webhooks/slack/events",{method:"POST",body,headers:{"x-slack-request-timestamp":timestamp,"x-slack-signature":"v0="+signature}});
    }
    api.conversationInfo.mockClear();
    api.hasChannelMember.mockClear();
    const githubCall = vi.spyOn(github, "call");
    const githubInventory = vi.spyOn(github, "inventory");
    const review = "Please review https://github.com/acme/demo/pull/1";
    const jobCount = async () => (await sql`SELECT id FROM slack_mention_summary_jobs`.execute(db)).rows.length;
    expect((await push(1,"Please review https://github.com/other/repo/pull/1",3)).status).toBe(200);
    expect(api.conversationInfo).not.toHaveBeenCalled();
    api.hasChannelMember.mockResolvedValueOnce(false);
    expect((await push(1,review,4)).status).toBe(200);
    expect(api.hasChannelMember).toHaveBeenCalledOnce();
    expect(await jobCount()).toBe(0);
    api.conversationInfo.mockResolvedValueOnce({canAccess:false,isExternalShared:false,channelMetadata:{id:"C102",name:"reviews"}});
    expect((await push(1,review,5)).status).toBe(200);
    expect(await jobCount()).toBe(0);
    api.conversationInfo.mockRejectedValueOnce(new Error("fixture provider outage"));
    expect((await push(1,review,6)).status).toBe(503);
    expect(await jobCount()).toBe(0);
    expect(githubCall).not.toHaveBeenCalled();
    expect(githubInventory).not.toHaveBeenCalled();
    expect((await db.selectFrom("chat_runs").select("id").execute())).toEqual([]);
    expect((await push(0,"The updated QA notes are ready.")).status).toBe(200);
    expect((await push(1,review,6)).status).toBe(200);
    const membershipReads = api.hasChannelMember.mock.calls.length;
    expect((await push(1,review,6)).status).toBe(200);
    expect(api.hasChannelMember).toHaveBeenCalledTimes(membershipReads);
    const jobs=await sql`SELECT bot_id,chat_id,routed->>'kind' AS kind FROM slack_mention_summary_jobs ORDER BY chat_id`.execute(db);
    expect(jobs.rows).toEqual([{bot_id:agents[1],chat_id:chats[1],kind:"review"},{bot_id:agents[0],chat_id:chats[0],kind:"summary"}]);
    expect(api.postMessage).not.toHaveBeenCalled();
  } finally { for(const finish of close.reverse()) await finish(); }
},30000);
