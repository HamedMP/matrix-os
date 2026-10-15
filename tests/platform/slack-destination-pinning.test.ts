import {describe,it,expect,vi,beforeEach} from "vitest";
import type {SlackAppRouteOptions} from "../../packages/platform/src/slack/routes.js";
const {machine,createSlackApp}=vi.hoisted(()=>({machine:vi.fn(),createSlackApp:vi.fn()}));
vi.mock("../../packages/platform/src/db.js",()=>({getRunningUserMachineByClerkId:machine,getRunningUserMachineByHandle:machine,getUserMachine:machine}));
vi.mock("../../packages/platform/src/slack/wiring.js",async(importOriginal)=>({...await importOriginal<object>(),createSlackApp}));
import {bootstrapPlatformSlack} from "../../packages/platform/src/slack-startup.js";
const env={SLACK_APP_ID:"A123",SLACK_CLIENT_ID:"123.456",SLACK_CLIENT_SECRET:"c".repeat(32),SLACK_SIGNING_SECRET:"s".repeat(32),SLACK_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,42).toString("base64"),SLACK_PUBLIC_BASE_URL:"https://app.matrix-os.com"};
const original={machineId:"11111111-1111-4111-8111-111111111111",clerkUserId:"user_original",handle:"original",status:"running",publicIPv4:"192.0.2.1"};
describe("production Slack durable destination routing",()=>{
 beforeEach(()=>{vi.resetAllMocks();machine.mockResolvedValue(original);createSlackApp.mockResolvedValue({});});
 it.each(["owner","runtime"])("never dispatches after the pinned %s changes between resolution and RPC",async(change)=>{
  const fetchImpl=vi.fn();
  await bootstrapPlatformSlack({env,db:{kysely:{}} as never,platformSecret:"a".repeat(64),platformJwtSecret:"j".repeat(64),collaboration:{organizations:{},repository:{getDirectoryRoute:async()=>({kind:"project",organizationId:"org_company",ownerId:change==="owner"?"user_other":"user_original",runtimeId:"vps:22222222-2222-4222-8222-222222222222"})}} as never,fetchImpl});
  const options=createSlackApp.mock.calls[0][0] as SlackAppRouteOptions;
  const input={installation:{organizationId:"org_company"},link:{actorId:"user_original"},binding:null,event:{kind:"direct_message"}} as never;
  const destination=await options.resolveDestination(input);
  expect(destination).toEqual({ownerId:"user_original",runtimeId:original.machineId});
  machine.mockResolvedValue({...original,...(change==="owner"?{clerkUserId:"user_other"}:{machineId:"22222222-2222-4222-8222-222222222222"})});
  await expect(options.dispatch({...input as object,destination,signal:AbortSignal.timeout(1000)} as never)).rejects.toThrow(/Slack (?:destination changed|home unavailable)/);
  expect(fetchImpl).not.toHaveBeenCalled();
 });
});
