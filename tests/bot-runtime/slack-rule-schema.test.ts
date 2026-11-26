import { expect,it,vi } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { createBotTools } from "../../packages/bot-runtime/src/tools.js";
const model={id:"claude-sonnet-5",name:"Synthetic",api:"anthropic-messages",provider:"anthropic",baseUrl:"http://127.0.0.1:1",reasoning:false,input:["text"],contextWindow:200000,maxTokens:2048,cost:{input:0,output:0,cacheRead:0,cacheWrite:0},compat:{supportsStrictTools:false}} as Model<"anthropic-messages">;
function tool(){return createBotTools({capabilities:["slack.rules"],broker:{tool:vi.fn(async()=>({ok:true,content:[{type:"text",text:"Saved"}]}))} as never,state:{waitingForPerson:false,effectUnknown:false}})[0]!;}
it("advertises rule arguments in the actual non-strict Anthropic payload instead of an empty object",async()=>{
 let payload:Record<string,any>|undefined;
 const result=stream(model,normalizeContext({messages:[{role:"user",content:"Create my standing rule",timestamp:1}],tools:[tool()]}),{apiKey:"synthetic-not-a-credential",maxRetries:0,onPayload:value=>{payload=value as Record<string,any>;throw new Error("Synthetic payload captured before transport");}});
 const completed=await result.result();
 expect(completed.errorMessage).toContain("Synthetic payload captured before transport");
 expect(payload?.tools).toHaveLength(1);
 const schema=payload?.tools?.find((item:any)=>item.name==="slack_summary_rules")?.input_schema;
 expect(schema?.properties?.operation).toMatchObject({type:"string",enum:expect.arrayContaining(["list","create","update","pause","resume","delete"])});
 expect(schema?.properties?.definition?.properties).toHaveProperty("trigger");
 expect(schema?.properties?.definition?.properties).toHaveProperty("cadence");
 const cadence=schema.properties.definition.properties.cadence.oneOf;
 expect(cadence).toEqual(expect.arrayContaining([
  expect.objectContaining({properties:{kind:{type:"string",const:"immediate"}},required:["kind"]}),
  expect.objectContaining({properties:{kind:{type:"string",const:"coalesce"},seconds:{type:"integer",minimum:10,maximum:3600}},required:["kind","seconds"]}),
 ]));
 expect(schema?.properties).toHaveProperty("sourceId");
 expect(schema?.properties).toHaveProperty("ownerInstruction");
});
it("gives native-wrapper structural create guidance without echoing malformed private values",async()=>{
 const native=tool();
 await expect(native.execute("call_wrong",{operation:"create",sourceId:"slack_enrolled_"+"a".repeat(32),ownerInstruction:"PRIVATE_OWNER_REQUEST",definition:"PRIVATE_BAD_DEFINITION"},AbortSignal.timeout(5000))).rejects.toThrow(/definition.*object.*cadence/iu);
 await expect(native.execute("call_wrong_2",{operation:"create",definition:"PRIVATE_BAD_DEFINITION"},AbortSignal.timeout(5000))).rejects.not.toThrow("PRIVATE_BAD_DEFINITION");
});
it("accepts correct structured create/list/control arguments through Pi validation and the strict broker wrapper",async()=>{
 const {validateToolArguments}=await import("@earendil-works/pi-ai/utils/validation");
 const dispatch=vi.fn(async(_request:unknown)=>({ok:true,content:[{type:"text",text:"Saved"}]}));
 const native=createBotTools({capabilities:["slack.rules"],broker:{tool:dispatch} as never,state:{waitingForPerson:false,effectUnknown:false}})[0]!;
 const inputs=[
  {operation:"list"},
  {operation:"create",sourceId:"slack_enrolled_"+"a".repeat(32),ownerInstruction:"From now on summarize every new message in #tech in English, focus on decisions and action items, group each thread for 60 seconds.",definition:{trigger:"new_message",cadence:{kind:"coalesce",seconds:60},focus:"decisions and action items",language:"English"}},
  {operation:"pause",ruleId:"srule_"+"b".repeat(32),baseRevision:1,ownerInstruction:"Please pause my Slack summary rule."},
 ];
 for(const [index,args] of inputs.entries()){
  const checked=validateToolArguments(native,{type:"toolCall",id:`call_${index}`,name:native.name,arguments:args});
  await expect(native.execute(`call_${index}`,checked,AbortSignal.timeout(5000))).resolves.toMatchObject({content:[{type:"text",text:"Saved"}]});
 }
 expect(dispatch).toHaveBeenCalledTimes(3);
 expect(dispatch.mock.calls[1]![0]).toMatchObject({capability:"slack.rules",args:inputs[1]});
 await expect(native.execute("call_extra",{operation:"list",definition:{trigger:"new_message"}},AbortSignal.timeout(5000))).rejects.toThrow("Omit irrelevant fields");
 expect(dispatch).toHaveBeenCalledTimes(3);
});

it("Pi rejects a string definition as an object-type error before broker dispatch",async()=>{
 const {validateToolArguments}=await import("@earendil-works/pi-ai/utils/validation");
 const dispatch=vi.fn();
 const native=createBotTools({capabilities:["slack.rules"],broker:{tool:dispatch} as never,state:{waitingForPerson:false,effectUnknown:false}})[0]!;
 expect(()=>validateToolArguments(native,{type:"toolCall",id:"call_wrong_pi",name:native.name,arguments:{operation:"create",sourceId:"slack_enrolled_"+"a".repeat(32),ownerInstruction:"Original owner instruction",definition:"opaque-definition-value"}})).toThrow(/definition[^\n]*object/iu);
 expect(dispatch).not.toHaveBeenCalled();
});
