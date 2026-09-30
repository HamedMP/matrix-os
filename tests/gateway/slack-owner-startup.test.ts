import {Hono} from "hono";
import {describe,it,expect,vi,afterEach} from "vitest";
import {registerOwnerSlack} from "../../packages/gateway/src/startup/slack-owner.js";
import {signSlackBridgeRequest} from "../../packages/contracts/src/slack-bridge.js";
const token="a".repeat(64),ownerId="user_host",now=()=>new Date("2026-09-30T10:00:00Z");
const event={eventId:"Ev123",appId:"A123",teamId:"T123",userId:"U123",channelId:"D123",ts:"1790762400.123",text:"hello",kind:"direct_message"};
async function signed(envelope:unknown){const path="/api/internal/slack/events",body=JSON.stringify(envelope);return {method:"POST",body,headers:{"content-type":"application/json",...await signSlackBridgeRequest({token,path,body,now:now()})}};}
function transport(){return {receive:vi.fn().mockResolvedValue({accepted:true}),drain:vi.fn().mockResolvedValue(undefined),close:vi.fn().mockResolvedValue(undefined)};}
afterEach(()=>vi.useRealTimers());
describe("owner Slack composition",()=>{
 it("routes signed DMs only to personal transport and mentions only to the company transport",async()=>{
  const app=new Hono(),personal=transport(),company=transport(),authority={authorize:vi.fn()};
  const runtime=registerOwnerSlack({app,ownerId,token,authority,personal,company,now,startDrain:false});
  const dm={ownerId,actorId:ownerId,organizationId:"org_company",event};
  expect((await app.request("/api/internal/slack/events",await signed(dm))).status).toBe(202);
  expect(personal.receive).toHaveBeenCalledWith(dm);expect(company.receive).not.toHaveBeenCalled();
  const mention={...dm,actorId:"user_employee",channelScopeId:"b8205675-a985-462c-a1be-5167adb5f6aa",event:{...event,kind:"mention",channelId:"C123"}};
  expect((await app.request("/api/internal/slack/events",await signed(mention))).status).toBe(202);
  expect(company.receive).toHaveBeenCalledWith(mention);expect(personal.receive).toHaveBeenCalledTimes(1);
  await runtime.close();expect(personal.close).toHaveBeenCalledOnce();expect(company.close).toHaveBeenCalledOnce();
 });
 it("fails unavailable services closed and never acknowledges before durable receive",async()=>{
  const app=new Hono(),personal=transport();let release!:()=>void;
  personal.receive.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  const runtime=registerOwnerSlack({app,ownerId,token,authority:{authorize:vi.fn()},personal,now,startDrain:false});
  const dm={ownerId,actorId:ownerId,organizationId:"org_company",event};
  const response=app.request("/api/internal/slack/events",await signed(dm));await vi.waitFor(()=>expect(personal.receive).toHaveBeenCalledOnce());
  let settled=false;void response.then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);release();expect((await response).status).toBe(202);
  expect((await app.request("/api/internal/slack/events",await signed({...dm,event:{...event,kind:"mention",channelId:"C123"}}))).status).toBe(503);
  await runtime.close();expect((await app.request("/api/internal/slack/events",await signed(dm))).status).toBe(503);
 });
 it("bounds drain overlap and closes after in-flight work without retaining a timer",async()=>{
  vi.useFakeTimers();const app=new Hono(),personal=transport();let release!:()=>void;
  personal.drain.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
  const runtime=registerOwnerSlack({app,ownerId,token,authority:{authorize:vi.fn()},personal,now});
  await vi.advanceTimersByTimeAsync(15_000);expect(personal.drain).toHaveBeenCalledTimes(1);
  const closed=runtime.close();expect(personal.close).not.toHaveBeenCalled();release();await closed;
  await vi.advanceTimersByTimeAsync(30_000);expect(personal.drain).toHaveBeenCalledTimes(1);expect(personal.close).toHaveBeenCalledOnce();
 });
 it("registers only unavailable routes when platform bridge authentication is missing",async()=>{
  const app=new Hono();const runtime=registerOwnerSlack({app,ownerId,authority:{authorize:vi.fn()},startDrain:false});
  expect((await app.request("/api/internal/slack/events",{method:"POST"})).status).toBe(503);
  expect((await app.request("/api/company-brain/scopes/anything/search")).status).toBe(503);await runtime.close();
 });
});
