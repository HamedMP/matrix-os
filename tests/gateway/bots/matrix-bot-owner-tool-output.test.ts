import { expect,it,vi } from "vitest";
import { createMatrixBotChatProviderAdapter } from "../../../packages/gateway/src/bots/chat-adapter.js";
import { createOwnerToolOutputProjection } from "../../../packages/gateway/src/chat/owner-tool-output.js";
import type { CanonicalProviderRunEvent } from "../../../packages/gateway/src/chat/provider-adapter.js";
const owner={type:"personal" as const,ownerId:"user_tool_owner"};
const chatId="chat_owner_tools",runId="run_owner_tools";
const key=Buffer.alloc(32,42);
async function events(toolOutputKey?:Buffer, capability = "artifact.read"){
 const adapter=createMatrixBotChatProviderAdapter({toolOutputKey,stopRuntime:vi.fn(),orchestrator:{
  start:()=>({events:(async function*(){yield {kind:"event",event:{type:"tool_progress",toolCallId:"call_rule",capability,phase:"failed",display:{name:capability === "slack.rules" ? "slack_summary_rules" : "read_artifact",output:"The requested operation did not finish."}}};})(),result:Promise.resolve({status:"failed"})}),steer:vi.fn(),cancel:vi.fn(),abandon:vi.fn(),
 } as never});
 const output:CanonicalProviderRunEvent[]=[];
 for await(const event of adapter.start({owner,chatId,runId,turnId:"cturn_owner_tools",prompt:"Create my rule",parts:[{type:"text",text:"Create my rule"}],selection:{instanceId:"matrix_bot_default",model:"auto"},interactionMode:"default",permissionMode:"default",signal:AbortSignal.timeout(5000)}))output.push(event);
 return output;
}
it("personal bot adapter seals native tool diagnostics and only the owning private Chat can reveal them",async()=>{
 const output=await events(key);
 const activity=output.find(event=>event.type==="tool.output");
 expect(activity).toHaveProperty("protectedOutput");
 expect(JSON.stringify(output)).not.toContain("The requested operation");
 const fixture={record:{chat:{id:chatId,ownerScope:owner}},activities:output.map(event=>({...event,chatId,runId}))};
 const content=fixture as never;
 const reveal=createOwnerToolOutputProjection(key,[owner.ownerId]);
 expect(JSON.stringify(reveal(owner,content))).toContain("The requested operation");
 expect(JSON.stringify(reveal({type:"personal",ownerId:"user_other"},content))).not.toContain("The requested operation");
 const shared={...fixture,record:{chat:{id:chatId,ownerScope:owner,collaboration:{mode:"shared"}}}} as never;
 expect(JSON.stringify(reveal(owner,shared))).not.toContain("The requested operation");
 expect(JSON.stringify(createOwnerToolOutputProjection(Buffer.alloc(32,7),[owner.ownerId])(owner,content))).not.toContain("The requested operation");
});
it.each([key, undefined])("keeps only progress for native Slack rules with or without an owner reveal key",async(toolOutputKey)=>{
 const output=await events(toolOutputKey, "slack.rules");
 expect(output).toContainEqual(expect.objectContaining({type:"agent.activity",kind:"phase",label:"Managing Slack summary rules",status:"failed"}));
 expect(JSON.stringify(output)).not.toContain("The requested operation");
 expect(output.find(event=>event.type==="tool.output")).toBeUndefined();
});
