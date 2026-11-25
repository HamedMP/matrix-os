import { withAccountDeletionAdmission } from "./account-deletion/admission.js";
import { Hono } from "hono";
import type { Kysely } from "kysely";
import type { Agent } from "undici";
import type { ClerkAuth } from "./clerk-auth.js";
import { getRunningUserMachineByClerkId, getRunningUserMachineByHandle, getUserMachine, type PlatformDB } from "./db.js";
import { createJourneyUserResolver } from "./journey-routes.js";
import { buildPlatformVerificationToken, timingSafeTokenEquals } from "./platform-token.js";
import type { PlatformCollaborationComposition } from "./collaboration/wiring.js";
import type { PlatformOrganizations } from "./organizations/wiring.js";
import { createSlackApp, loadSlackAppConfig } from "./slack/wiring.js";
import type { SlackDatabase } from "./slack/database.js";
import { loadSlackDevThreadContextGrant, loadSlackThreadContextGrant } from "./slack/thread-context.js";
import { loadSlackMentionSummaryRule } from "./slack/mention-summary.js";
import { createSlackDevHomeDispatcher, loadSlackDevIngressCertificate } from "./slack-dev-home-tls.js";
import { createSlackHomeTransport, type SlackHome } from "./slack-home-transport.js";
import { createSlackMachineResolver, isSlackDevMachineAvailable, isSlackMachineAvailable, loadSlackDevAcceptance, loadSlackPreviewHandle } from "./slack/home-resolver.js";

const slackPaths = ["/api/slack/*", "/webhooks/slack/*", "/internal/slack/*", "/slack/link"] as const;

function unavailable() {
  const routes=new Hono();
  for(const path of slackPaths)
    routes.all(path,c=>c.json({error:"Slack unavailable"},503));
  return {routes,async close(){}};
}
export async function bootstrapPlatformSlack(options:{env:NodeJS.ProcessEnv;db:PlatformDB;platformSecret:string;platformJwtSecret:string;
  clerkAuth?:ClerkAuth;collaboration?:PlatformCollaborationComposition;devOrganizations?:Pick<PlatformOrganizations, "repository" | "projection">;
  customerVpsProxyDispatcher?:Agent;fetchImpl?:typeof fetch;startCleanup?:boolean}) {
  let config: ReturnType<typeof loadSlackAppConfig>;
  let previewHandle: string | undefined;
  let devConfig: ReturnType<typeof loadSlackDevAcceptance>;
  let devIngressCertificate: ReturnType<typeof loadSlackDevIngressCertificate> | undefined;
  let contextGrant: ReturnType<typeof loadSlackThreadContextGrant>;
  try {
    config = loadSlackAppConfig(options.env);
    devConfig = loadSlackDevAcceptance(options.env);
    if (devConfig) {
      const dev = devConfig.target;
      if (!config || !isDevCallbackOrigin(config.publicBaseUrl, dev.machineId)
        || timingSafeTokenEquals(devConfig.bridgeToken, buildPlatformVerificationToken(dev.handle, options.platformSecret))) {
        throw new Error("Slack Dev callback unavailable");
      }
      devIngressCertificate = loadSlackDevIngressCertificate(options.env.SLACK_DEV_INGRESS_CA_PEM);
      contextGrant = loadSlackDevThreadContextGrant(options.env, dev, config.appId);
    } else {
      previewHandle = loadSlackPreviewHandle(options.env);
    }
  } catch (error: unknown) {
    console.warn("[slack] app configuration unavailable", error instanceof Error ? error.name : "UnknownError");
    return unavailable();
  }
  const dev = devConfig?.target;
  if (!dev) {
    try { contextGrant = loadSlackThreadContextGrant(options.env, previewHandle); }
    catch (error) { console.warn("[slack] thread context configuration unavailable", error instanceof Error ? error.name : "UnknownError"); }
  }
  const mentionSummaryRule = dev ? undefined : loadSlackMentionSummaryRule(options.env, contextGrant, previewHandle);
  const collaboration = options.collaboration && "organizations" in options.collaboration ? options.collaboration : undefined;
  const organizations = (dev ? options.devOrganizations : undefined) ?? collaboration?.organizations;
  if (!config || !organizations || !options.platformSecret) return unavailable();
  const resolveActor = createJourneyUserResolver({ clerkAuth: options.clerkAuth, syncJwtSecret: dev ? undefined : options.platformJwtSecret });
  async function getDevMachine() {
    if (!dev) return undefined;
    const machine = await getUserMachine(options.db, dev.machineId);
    return isSlackDevMachineAvailable(machine, dev) ? machine : undefined;
  }
  const fetchImpl: typeof fetch = options.fetchImpl ?? (dev ? fetch : (input, init) => fetch(input, {
    ...init, signal: init?.signal ?? AbortSignal.timeout(10_000),
    ...(options.customerVpsProxyDispatcher ? { dispatcher: options.customerVpsProxyDispatcher } : {}),
  } as RequestInit));
  const devHomeDispatcher = devIngressCertificate ? createSlackDevHomeDispatcher(devIngressCertificate) : undefined;
  const rpc = createSlackHomeTransport({
    fetchImpl: devHomeDispatcher
      ? (input, init) => fetchImpl(input, { ...init, dispatcher: devHomeDispatcher } as RequestInit)
      : fetchImpl,
  });
  const resolveMachine=createSlackMachineResolver({previewHandle, devAcceptance: dev,
    findDirectoryRoute: async scopeId => collaboration?.repository.getDirectoryRoute(scopeId),
    findMachineById:id=>getUserMachine(options.db,id),
    findPersonalMachine:(actorId,slot)=>getRunningUserMachineByClerkId(options.db,actorId,slot)});
  async function homeFor(actorId:string,scopeId?:string,organizationId?:string):Promise<SlackHome & {runtimeId:string}> {
    const machine=await resolveMachine(actorId,scopeId,organizationId);
    return {runtimeId:machine.machineId,ownerId:machine.clerkUserId,origin:`https://${machine.publicIPv4}`,token:devConfig?.bridgeToken ?? buildPlatformVerificationToken(machine.handle,options.platformSecret)};
  }
  const slack = await createSlackApp({db:options.db.kysely as unknown as Kysely<SlackDatabase>,config,resolveActor,fetchImpl,startCleanup:options.startCleanup,
    linkTransaction: (actorId, work) => withAccountDeletionAdmission(options.db, actorId,
      trx => work(trx.executor as unknown as Kysely<SlackDatabase>), options.env),
    contextGrant, mentionSummaryRule, readOnlyDev: dev,
    dispatchContext: async (envelope, signal) => {
      const home = await homeFor(envelope.ownerId);
      if (home.ownerId !== envelope.ownerId || home.runtimeId !== envelope.runtimeId) throw new Error("Slack destination changed");
      await rpc(home, "context", envelope, signal);
    },
    isCurrentMember: async input =>
      (!dev || (input.actorId === dev.ownerId && input.organizationId === dev.organizationId && Boolean(await getDevMachine())))
      && organizations.projection.isCurrentMember(input),
    requireOrgAdmin:async input=>{
      if (dev && (input.actorId !== dev.ownerId || input.organizationId !== dev.organizationId || !await getDevMachine())) return false;
      const refreshed=await organizations.projection.reconcile(input.organizationId);
      if(!refreshed.verified || !await organizations.projection.isCurrentMember(input))return false;
      const membership=await organizations.repository.getMembership(input);
      return membership?.state==="active" && membership.role==="org:admin";
    },
    authorizeChannelBinding:async input=>{
      const home=await homeFor(input.actorId,input.scopeId,input.organizationId);
      return (await rpc(home,"authorize",{ownerId:home.ownerId,organizationId:input.organizationId,actorId:input.actorId,scopeId:input.scopeId,action:"manage_members"})).allowed===true;
    },
    resolveDestination:async({installation,link,binding})=>{
      const home=await homeFor(link.actorId,binding?.scopeId,installation.organizationId);
      return {ownerId:home.ownerId,runtimeId:home.runtimeId};
    },
    dispatch:async({installation,link,binding,event,destination,signal})=>{
      const home=await homeFor(link.actorId,binding?.scopeId,installation.organizationId);
      if(home.ownerId!==destination.ownerId || home.runtimeId!==destination.runtimeId) throw new Error("Slack destination changed");
      await rpc(home,"events",{ownerId:home.ownerId,organizationId:installation.organizationId,actorId:link.actorId,
        ...(binding?.approvedOutput?{channelScopeId:binding.scopeId,companyPublicationApproved:true}:{}),event},signal);
      return {ownerId:home.ownerId};
    },
    authenticateRuntime:async c=>{
      const handle=c.req.header("x-matrix-handle");
      if(!handle || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(handle))return null;
      const authorization = c.req.header("authorization");
      if (devConfig) {
        const token = authorization?.match(/^Bearer ([0-9a-f]{64})$/)?.[1];
        if (handle !== devConfig.target.handle || !timingSafeTokenEquals(token, devConfig.bridgeToken)) return null;
        const target = await getDevMachine();
        return target ? { ownerId: target.clerkUserId, runtimeId: target.machineId } : null;
      }
      const machine=await getRunningUserMachineByHandle(options.db,handle);
      const bearer=authorization?.replace(/^Bearer /,"");
      if (!isSlackMachineAvailable(machine, previewHandle)
        || !timingSafeTokenEquals(bearer, buildPlatformVerificationToken(machine.handle, options.platformSecret))) return null;
      return { ownerId: machine.clerkUserId, runtimeId: machine.machineId };
    },
    authorizeReply:async({destination,ownerId,publication})=>{
      if(destination.ownerId!==ownerId || !await organizations.projection.isCurrentMember({actorId:destination.actorId,organizationId:destination.organizationId}))return false;
      if(!destination.scopeId)return ownerId===destination.actorId && destination.channelId.startsWith("D");
      const home=await homeFor(destination.actorId,destination.scopeId,destination.organizationId);
      if(home.ownerId!==ownerId || home.runtimeId!==destination.runtimeId)return false;
      return (await rpc(home,"authorize",{ownerId,organizationId:destination.organizationId,actorId:destination.actorId,scopeId:destination.scopeId,
        ...(publication?{action:"publish_reply",appId:destination.appId,teamId:destination.teamId,eventId:destination.eventId,textDigest:publication.textDigest}:{action:"discuss"})})).allowed===true;
    },
  }).catch(async (error: unknown) => {
    await devHomeDispatcher?.destroy();
    throw error;
  });
  if (!dev) return slack;
  const routes = new Hono();
  const host = new URL(config.publicBaseUrl).host;
  for (const path of slackPaths) {
    routes.use(path, async (c, next) => {
      // Cloud Run terminates TLS before forwarding the request to Node.
      if (new URL(c.req.url).host !== host) return c.json({ error: "Forbidden" }, 403);
      await next();
    });
  }
  routes.route("/", slack.routes);
  for (const path of slackPaths) routes.all(path, c => c.json({ error: "Not found" }, 404));
  return {
    ...slack,
    routes,
    async close() {
      try { await slack.close(); }
      finally { await devHomeDispatcher?.close(); }
    },
  };
}

function isDevCallbackOrigin(publicBaseUrl: string, machineId: string): boolean {
  const origin = new URL(publicBaseUrl);
  const slotTag = `slack-dev-${machineId.slice(0, 8)}---`;
  return !origin.port && origin.hostname.startsWith(slotTag)
    && /^matrix-platform-preview-[a-z0-9]+(?:-[a-z0-9]+)*\.a\.run\.app$/.test(origin.hostname.slice(slotTag.length));
}
