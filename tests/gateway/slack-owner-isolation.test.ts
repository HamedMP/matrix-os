import {Hono} from "hono";
import {describe,it,expect,vi} from "vitest";
const hooks=vi.hoisted(()=>({company:vi.fn(),personal:vi.fn(),receive:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../../packages/gateway/src/startup/slack-company.js",()=>({startSlackCompany:hooks.company}));
vi.mock("../../packages/gateway/src/startup/slack-owner-client.js",()=>({createSlackOwnerClient:()=>({sendReply:vi.fn()})}));
vi.mock("../../packages/gateway/src/slack/personal-database.js",()=>({bootstrapSlackPersonalDatabase:vi.fn().mockResolvedValue(undefined)}));
vi.mock("../../packages/gateway/src/slack/personal-service.js",()=>({
 SlackPersonalService:class{constructor(){hooks.personal();}receive=hooks.receive;drain=async()=>{};close=async()=>{};},
 createSlackPersonalChatResolver:()=>({}),createSlackPersonalSubmitter:()=>vi.fn(),createSlackPersonalResultReader:()=>vi.fn(),
}));
import {startOwnerSlack} from "../../packages/gateway/src/startup/slack-owner.js";
import {signSlackBridgeRequest} from "../../packages/contracts/src/slack-bridge.js";
describe("Slack startup dependency isolation",()=>{
 it("keeps personal DMs available when company database or collaboration startup fails",async()=>{
  hooks.company.mockRejectedValue(new Error("CompanyDatabaseUnavailable"));const app=new Hono(),token="a".repeat(64);
  const runtime=await startOwnerSlack({app,ownerId:"user_host",token,platformUrl:"https://platform.example",handle:"host",
   repository:{kysely:{}} as never,orchestrator:{} as never,executionRoots:{} as never,
   collaboration:{authority:{authorize:vi.fn()}} as never,bots:{adapter:{},instantiation:{}} as never});
  expect(hooks.personal).toHaveBeenCalledOnce();
  const path="/api/internal/slack/events",body=JSON.stringify({ownerId:"user_host",actorId:"user_host",organizationId:"org_company",
   event:{eventId:"Ev123",appId:"A123",teamId:"T123",userId:"U123",channelId:"D123",ts:`${Math.floor(Date.now()/1000)}.123`,text:"hello",kind:"direct_message"}});
  expect((await app.request(path,{method:"POST",body,headers:await signSlackBridgeRequest({token,path,body})})).status).toBe(202);await runtime.close();
 });
});
