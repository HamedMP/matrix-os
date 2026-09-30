import {Hono} from "hono";
import type {SlackBridgeEnvelope,SlackPublicationIdentity} from "@matrix-os/contracts/slack-bridge";
import type {CollaborationAuthority} from "../collaboration/authority.js";
import {createSlackBridgeRoutes} from "./slack-bridge.js";

interface SlackInboxTransport {
  receive(envelope:SlackBridgeEnvelope):Promise<unknown>;
  drain():Promise<void>;
  close():Promise<void>;
  authorizePublication?(input:SlackPublicationIdentity):Promise<boolean>;
}

/** The ingress acknowledges only durable storage; background passes never overlap. */
export function registerOwnerSlack(options:{
  app:Hono;ownerId:string;token?:string;authority:Pick<CollaborationAuthority,"authorize">;
  personal?:SlackInboxTransport;company?:SlackInboxTransport;brainRoutes?:Hono;
  now?:()=>Date;startDrain?:boolean;
}) {
  let stopping=false;
  let active:Promise<void>|undefined;
  const authorizePublication=options.company?.authorizePublication?.bind(options.company);
  const services=[options.personal,options.company].filter((service):service is SlackInboxTransport=>!!service);
  const unavailable=new Hono();unavailable.all("*",c=>c.json({error:"Slack unavailable"},503));
  if(options.token && /^[a-f0-9]{64}$/.test(options.token)) {
    options.app.route("/",createSlackBridgeRoutes({ownerId:options.ownerId,token:options.token,authority:options.authority,now:options.now,
      authorizePublication:async input=>{
        if(stopping || !authorizePublication)return false;
        const allowed=await authorizePublication(input);
        return !stopping && allowed;
      },
      async receive(envelope){
        const service=envelope.event.kind==="direct_message"?options.personal:options.company;
        if(stopping || !service)throw new Error("SlackServiceUnavailable");
        return service.receive(envelope);
      },
    }));
  } else options.app.route("/api/internal/slack",unavailable);
  options.app.route("/api/company-brain",options.brainRoutes??unavailable);
  const drain=()=>{
    if(stopping || active)return;
    active=Promise.allSettled(services.map(service=>service.drain())).then(results=>{
      for(const result of results)if(result.status==="rejected")console.warn("[slack] drain unavailable",result.reason instanceof Error?result.reason.name:"UnknownError");
    }).finally(()=>{active=undefined;});
  };
  const timer=options.startDrain!==false&&services.length?setInterval(drain,5_000):undefined;
  timer?.unref();
  return {async close(){
    stopping=true;if(timer)clearInterval(timer);await active;
    const results=await Promise.allSettled(services.map(service=>service.close()));
    for(const result of results)if(result.status==="rejected")console.warn("[slack] shutdown unavailable",result.reason instanceof Error?result.reason.name:"UnknownError");
  }};
}

import type {Kysely} from "kysely";
import type {ChatRepository} from "../chat/repository.js";
import type {CanonicalChatOrchestrator} from "../chat/orchestrator.js";
import type {ChatExecutionRootResolver} from "../chat/execution-root.js";
import type {GatewayCollaborationRuntime} from "../collaboration/wiring.js";
import {ownerBotExecutor} from "../bots/instantiation.js";
import type {BotServices} from "./bots.js";
import {createSlackOwnerClient} from "./slack-owner-client.js";
import {startSlackCompany} from "./slack-company.js";
import {bootstrapSlackPersonalDatabase,type SlackPersonalDatabase} from "../slack/personal-database.js";
import {SlackPersonalService,createSlackPersonalChatResolver,createSlackPersonalSubmitter,createSlackPersonalResultReader} from "../slack/personal-service.js";

/** Owner-side databases are borrowed from canonical Chat and remain owned by it. */
export async function startOwnerSlack(options:{app:Hono;ownerId?:string;token?:string;platformUrl?:string;handle?:string;
  repository:ChatRepository|null;orchestrator:CanonicalChatOrchestrator|null;executionRoots:ChatExecutionRootResolver|null;
  collaboration:GatewayCollaborationRuntime|null;bots:BotServices|undefined;
}) {
  let personal:SlackPersonalService|undefined;
  let company:Awaited<ReturnType<typeof startSlackCompany>>|undefined;
  const ownerId=options.ownerId??"";
  const authority=options.collaboration?.authority??{async authorize(){throw new Error("SlackAuthorityUnavailable");}};
  if(/^user_[A-Za-z0-9_-]+$/.test(ownerId) && options.token && options.platformUrl && options.handle
    && options.repository && options.orchestrator && options.executionRoots && options.bots) {
    try {
      const client=createSlackOwnerClient({platformUrl:options.platformUrl,handle:options.handle,token:options.token});
      if(options.collaboration) {
        try {
          company=await startSlackCompany({ownerId,repository:options.repository,
            collaboration:options.collaboration,executionRoots:options.executionRoots,bots:options.bots,client});
        } catch(error:unknown) {
          console.warn("[slack] company composition unavailable",error instanceof Error?error.name:"UnknownError");
        }
      }
      if(options.bots.adapter) {
        const personalDb=options.repository.kysely as unknown as Kysely<SlackPersonalDatabase>;
        await bootstrapSlackPersonalDatabase(personalDb);
        const botDb=ownerBotExecutor(options.repository.kysely);
        personal=new SlackPersonalService({db:personalDb,ownerId,
          ...createSlackPersonalChatResolver({ownerId,instantiation:options.bots.instantiation}),
          submitPersonal:createSlackPersonalSubmitter({db:botDb,orchestrator:options.orchestrator}),
          readResult:createSlackPersonalResultReader(botDb),sendReply:client.sendReply,onAdmitted:client.react});
      }
    } catch(error:unknown) {
      console.warn("[slack] owner composition unavailable",error instanceof Error?error.name:"UnknownError");
    }
  }
  return registerOwnerSlack({app:options.app,ownerId,token:options.token,authority,personal,company:company?.service,brainRoutes:company?.routes});
}
