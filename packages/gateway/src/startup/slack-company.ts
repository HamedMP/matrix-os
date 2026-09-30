import { createHash } from "node:crypto";
import type { Kysely } from "kysely";
import type { ChatRepository } from "../chat/repository.js";
import type { ChatExecutionRootResolver } from "../chat/execution-root.js";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";
import type { GatewayCollaborationRuntime } from "../collaboration/wiring.js";
import type { OwnerCollaborationDatabase } from "../collaboration/database.js";
import { createCodexOwnerIdentityResolver } from "../collaboration/codex-owner-identity.js";
import { createSharedBotModelRouteResolver } from "../bots/codex-route.js";
import { createBotBindingsRepository } from "../bots/repositories/bindings.js";
import { ownerBotExecutor } from "../bots/instantiation.js";
import { createCompanyBotRuntime } from "./company-bot-runtime.js";
import type { BotServices } from "./bots.js";
import { bootstrapCompanyBrainDatabase, type CompanyBrainDatabase } from "../company-brain/database.js";
import { CompanyBrainService } from "../company-brain/service.js";
import { createCompanyBrainRoutes } from "../company-brain/routes.js";
import { bootstrapSlackCompanyDatabase, type SlackCompanyDatabase } from "../slack/database.js";
import { SlackCompanyService } from "../slack/company-service.js";
import { createSlackThreadResolver } from "../slack/thread-resolver.js";
import { createSlackCanonicalReaders } from "../slack/canonical-readers.js";
import { SlackCompanyError } from "../slack/schemas.js";
import type { createSlackOwnerClient } from "./slack-owner-client.js";

export function createCompanyBotSetup(options:{homePath:string;ownerId:string;repository:ChatRepository;collaboration:GatewayCollaborationRuntime;
  providers:AiProviderSnapshotReader;getBots():BotServices|undefined;modelId?:string}) {
  const collaboration=options.collaboration;
  if(!collaboration.executionPolicies || !collaboration.ownerSource || !collaboration.runBindings)return undefined;
  const lifetime=new AbortController();
  const db=options.repository.kysely as unknown as Kysely<OwnerCollaborationDatabase>;
  const runtime=createCompanyBotRuntime({ownerId:options.ownerId,modelId:options.modelId,authority:collaboration.authority,
    policies:collaboration.executionPolicies,ownerSource:collaboration.ownerSource,
    resolveModel:createSharedBotModelRouteResolver({providers:options.providers,lifetime:lifetime.signal,
      resolveCodexIdentity:createCodexOwnerIdentityResolver({homePath:options.homePath})}),
    getAdapter:()=>options.getBots()?.adapter,
    async loadRun(runId){
      const row=await db.selectFrom("chat_runs as run").innerJoin("chats as chat","chat.id","run.chat_id")
        .innerJoin("collaboration_run_bindings as binding","binding.run_id","run.id")
        .select(["run.chat_id","run.status","run.driver_kind","binding.scope_id"])
        .where("run.id","=",runId).where("chat.owner_type","=","personal").where("chat.owner_id","=",options.ownerId).executeTakeFirst();
      const binding=await collaboration.runBindings!.get(runId);
      return row && binding && row.driver_kind==="matrix_bot"?{scopeId:row.scope_id,chatId:row.chat_id,status:row.status,binding}:null;
    },
  });
  return{...runtime,close(){lifetime.abort();}};
}

export async function startSlackCompany(options:{ownerId:string;repository:ChatRepository;collaboration:GatewayCollaborationRuntime;
  executionRoots:ChatExecutionRootResolver;bots:BotServices;client:ReturnType<typeof createSlackOwnerClient>}) {
  const {collaboration,repository}=options;
  const db=repository.kysely as unknown as Kysely<OwnerCollaborationDatabase>;
  const brainDb=repository.kysely as unknown as Kysely<CompanyBrainDatabase>;
  const slackDb=repository.kysely as unknown as Kysely<SlackCompanyDatabase>;
  await bootstrapCompanyBrainDatabase(brainDb);
  const brain=new CompanyBrainService({db:brainDb,authority:collaboration.authority,ownerId:options.ownerId});
  const routes=createCompanyBrainRoutes({service:brain});
  if(!collaboration.chatExecutionAdapter || !collaboration.sharedAiCapability?.eligibility.matrixBot || !options.bots.adapter) {
    return {brain,routes,service:undefined,async close(){}};
  }
  await bootstrapSlackCompanyDatabase(slackDb);
  const execution=collaboration.chatExecutionAdapter;
  const readers=createSlackCanonicalReaders(repository.kysely);
  const resolveThread=createSlackThreadResolver({db,chats:repository,authority:collaboration.authority,executionRoots:options.executionRoots,
    async getEligibility(){const capability=collaboration.sharedAiCapability;if(!capability)throw new Error("Company execution unavailable");return capability;},
    async resolveCompanyBot(input){
      // Dedicated definition per company Project: no employee's private bot instructions are copied.
      const key=createHash("sha256").update(`company:${input.ownerId}:${input.projectScopeId}`).digest("hex").slice(0,32);
      const bot=await options.bots.instantiation.instantiate(input.ownerId,{clientRequestId:`req_${key}`,
        recipe:{recipeId:"company-brain",version:"2026-09-30.1"},name:"Company Matrix"});
      await createBotBindingsRepository(ownerBotExecutor(repository.kysely)).bindGroup({ownerId:input.ownerId,botId:bot.agent.id,chatId:input.chatId,now:new Date().toISOString()});
    },
    async initializeThread(input){
      const chat=await repository.kysely.selectFrom("chats").select("bound_at_turn_id").where("id","=",input.chatId)
        .where("owner_id","=",input.ownerId).where("owner_type","=","personal").executeTakeFirst();
      if(chat?.bound_at_turn_id)return;
      const accepted=await readers.findAcceptedRequest!({ownerId:input.ownerId,scopeId:input.scopeId,chatId:input.chatId,actorId:input.ownerId,clientRequestId:input.clientRequestId});
      if(accepted)return;
      const context=await collaboration.authority.authorize({scopeId:input.scopeId,actorId:input.ownerId,action:"request_ai"});
      const read=await collaboration.authority.authorize({scopeId:input.scopeId,actorId:input.ownerId,action:"read"});
      try {
        await execution.submit(context,{clientRequestId:input.clientRequestId,expectedRevision:await execution.resourceRevision(read),
          text:"Initialize this company thread. Wait for employee requests. Use only supplied shared evidence. Do not consult private context."});
      } catch(error:unknown) {
        // Another initializer may have won this revision. Retain the employee receipt;
        // its next attempt rechecks the binding and reconciles the exact initializer.
        if(error instanceof Error && "code" in error && error.code==="conflict") throw new SlackCompanyError("unavailable");
        throw error;
      }
    },
  });
  const service=new SlackCompanyService({db:slackDb,ownerId:options.ownerId,authority:collaboration.authority,execution,resolveThread,...readers,
    brain,readThread:options.client.readThread,sendReply:options.client.sendReply,onAdmitted:options.client.react});
  return{service,brain,routes,async close(){await service.close();}};
}
