import { describe, expect, it, vi } from "vitest";
import { createMailCallRoutes } from "../../packages/gateway/src/integrations/mail-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
const binding={service:"gmail",connectionId:"conn",accountLabel:"Personal",expectedEmail:"reader@example.com"};
function setup(changes:Record<string,unknown>={},internal=true){
  const call=vi.fn(async(raw:{action:string})=>raw.action==="get_profile"?{emailAddress:binding.expectedEmail}:{id:"msg",labelIds:[]});
  const app=createMailCallRoutes({db:{listConnectedServices:async()=>[{id:"conn",user_id:"owner",service:"gmail",status:"active",account_label:"Personal",account_email:binding.expectedEmail,pipedream_account_id:"apn",...changes}],getUserById:async()=>({pipedream_external_id:"pd_owner"})} as unknown as PlatformDb,
    pipedream:{boundedMail:call} as unknown as PipedreamConnectClient,resolveUserId:async()=>"owner",authorizeInternal:async()=>internal});
  const request=(scope?:string)=>app.request("/mail-call",{method:"POST",headers:{"content-type":"application/json",...(scope?{"x-matrix-integration-read-scope":scope}:{})},body:JSON.stringify({binding,operation:{action:"modify_message",params:{messageId:"msg",removeLabelIds:["INBOX"]}}})});
  return{call,request};
}
describe("internal mail dispatch",()=>{
  it("requires verified internal delegation before account reads or writes",async()=>{const f=setup({},false);expect((await f.request()).status).toBe(403);expect(f.call).not.toHaveBeenCalled();});
  it("denies read-only runtime capabilities",async()=>{const f=setup();expect((await f.request("read")).status).toBe(403);expect(f.call).not.toHaveBeenCalled();});
  it.each([{id:"rebound"},{user_id:"other"},{status:"revoked"},{account_email:"other@example.com"}])("rejects stale binding %j",async change=>{const f=setup(change);expect((await f.request()).status).toBe(403);expect(f.call).not.toHaveBeenCalled();});
  it("verifies live email identity before the single inbox mutation",async()=>{const f=setup();expect((await f.request()).status).toBe(200);expect(f.call.mock.calls.map(([v])=>v.action)).toEqual(["get_profile","modify_message"]);});
});
