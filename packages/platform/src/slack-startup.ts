import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Agent } from "undici";
import type { ClerkAuth } from "./clerk-auth.js";
import { getRunningUserMachineByClerkId, getRunningUserMachineByHandle, getUserMachine, type PlatformDB } from "./db.js";
import { createJourneyUserResolver } from "./journey-routes.js";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "./platform-token.js";
import type { PlatformCollaborationComposition } from "./collaboration/wiring.js";
import { createSlackApp, loadSlackAppConfig } from "./slack/wiring.js";
import type { SlackDatabase } from "./slack/database.js";
import { createSlackHomeTransport, type SlackHome } from "./slack-home-transport.js";

function unavailable() {
  const routes=new Hono();
  for(const path of ["/api/slack/*","/webhooks/slack/*","/internal/slack/*","/slack/link"])
    routes.all(path,c=>c.json({error:"Slack unavailable"},503));
  return {routes,async close(){}};
}
export async function bootstrapPlatformSlack(options:{env:NodeJS.ProcessEnv;db:PlatformDB;platformSecret:string;platformJwtSecret:string;
  clerkAuth?:ClerkAuth;collaboration?:PlatformCollaborationComposition;customerVpsProxyDispatcher?:Agent;fetchImpl?:typeof fetch;startCleanup?:boolean}) {
  let config:ReturnType<typeof loadSlackAppConfig>;
  try {config=loadSlackAppConfig(options.env);}catch(error:unknown){console.warn("[slack] app configuration unavailable",error instanceof Error?error.name:"UnknownError");return unavailable();}
  const collaboration=options.collaboration;
  if(!config || !collaboration || !("organizations" in collaboration) || !collaboration.organizations || !options.platformSecret) return unavailable();
  const organizations=collaboration.organizations;
  const directory=collaboration.repository;
  const resolveActor=createJourneyUserResolver({clerkAuth:options.clerkAuth,syncJwtSecret:options.platformJwtSecret});
  const fetchImpl:typeof fetch=options.fetchImpl??((input,init)=>fetch(input,{...init,signal:init?.signal??AbortSignal.timeout(10_000),
    ...(options.customerVpsProxyDispatcher?{dispatcher:options.customerVpsProxyDispatcher}:{})} as RequestInit));
  const rpc=createSlackHomeTransport({fetchImpl});
  async function homeFor(actorId:string,scopeId?:string,organizationId?:string):Promise<SlackHome> {
    let machine;
    if(scopeId) {
      const route=await directory.getDirectoryRoute(scopeId);
      if(!route || route.kind!=="project" || route.organizationId!==organizationId) throw new Error("Slack home unavailable");
      const id=/^vps:([0-9a-f-]{36})$/.exec(route.runtimeId)?.[1];
      machine=id?await getUserMachine(options.db,id):undefined;
      if(!machine || machine.clerkUserId!==route.ownerId) throw new Error("Slack home unavailable");
    } else machine=await getRunningUserMachineByClerkId(options.db,actorId);
    if(!machine || machine.status!=="running" || !machine.publicIPv4) throw new Error("Slack home unavailable");
    return {ownerId:machine.clerkUserId,origin:`https://${machine.publicIPv4}`,token:buildPlatformVerificationToken(machine.handle,options.platformSecret)};
  }
  return createSlackApp({db:options.db.kysely as unknown as Kysely<SlackDatabase>,config,resolveActor,fetchImpl,startCleanup:options.startCleanup,
    isCurrentMember:input=>organizations.projection.isCurrentMember(input),
    requireOrgAdmin:async input=>{
      const refreshed=await organizations.projection.reconcile(input.organizationId);
      if(!refreshed.verified || !await organizations.projection.isCurrentMember(input))return false;
      const membership=await organizations.repository.getMembership(input);
      return membership?.state==="active" && membership.role==="org:admin";
    },
    authorizeChannelBinding:async input=>{
      const home=await homeFor(input.actorId,input.scopeId,input.organizationId);
      return (await rpc(home,"authorize",{ownerId:home.ownerId,organizationId:input.organizationId,actorId:input.actorId,scopeId:input.scopeId,action:"manage_members"})).allowed===true;
    },
    dispatch:async({installation,link,binding,event,signal})=>{
      const home=await homeFor(link.actorId,binding?.scopeId,installation.organizationId);
      await rpc(home,"events",{ownerId:home.ownerId,organizationId:installation.organizationId,actorId:link.actorId,
        ...(binding?.approvedOutput?{channelScopeId:binding.scopeId,companyPublicationApproved:true}:{}),event},signal);
      return {ownerId:home.ownerId};
    },
    authenticateRuntime:async c=>{
      const handle=c.req.header("x-matrix-handle");
      if(!handle || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle))return null;
      const machine=await getRunningUserMachineByHandle(options.db,handle);
      const bearer=c.req.header("authorization")?.replace(/^Bearer /,"");
      return machine && timingSafeTokenEquals(bearer,buildPlatformVerificationToken(machine.handle,options.platformSecret))?{ownerId:machine.clerkUserId}:null;
    },
    authorizeReply:async({destination,ownerId})=>{
      if(destination.ownerId!==ownerId || !await organizations.projection.isCurrentMember({actorId:destination.actorId,organizationId:destination.organizationId}))return false;
      if(!destination.scopeId)return ownerId===destination.actorId && destination.channelId.startsWith("D");
      const home=await homeFor(destination.actorId,destination.scopeId,destination.organizationId);
      if(home.ownerId!==ownerId)return false;
      return (await rpc(home,"authorize",{ownerId,organizationId:destination.organizationId,actorId:destination.actorId,scopeId:destination.scopeId,action:"discuss"})).allowed===true;
    },
  });
}
