import {expect,it} from "vitest";
import {canonicalChatPresentation} from "../../desktop/src/renderer/src/features/chat/canonical-chat-presentation";
import {projectCanonicalTranscript} from "../../shell/src/lib/canonical-chat-terminal-notices";
import {buildTranscript} from "../../apps/mobile/lib/canonical-chat-transcript";
import {nativeScheduledMessageFixture} from "../helpers/native-scheduled-message-fixture";
it("retains real unbound receipt messages in all transcript renderers during a foreground run and after reload",()=>{
 const detail=nativeScheduledMessageFixture("running");
 const receipt={type:"routine_receipt" as const,engine:"matrix" as const,kind:"output" as const,routineId:`rt_${"a".repeat(24)}`,fireId:`fire_${"b".repeat(24)}`,attempt:1,status:"unknown" as const,scheduledFor:detail.messages[0]!.createdAt,canonicalChatId:"chat_executor",canonicalTaskId:"task_real_execution",model:"gpt-6-luna"};
 detail.messages.push({...detail.messages[0]!,id:"msg_real_receipt",seq:3,turnId:undefined,runId:undefined,parts:[{type:"text",text:"Committed output"},receipt]});
 const before=JSON.stringify(detail);const reloaded=JSON.parse(before);
 expect(projectCanonicalTranscript(reloaded).find(message=>message.id==="msg_real_receipt")?.routineReceipt).toEqual(receipt);
 expect(buildTranscript(reloaded).find(message=>message.id==="msg_real_receipt")?.routineReceipt).toEqual(receipt);
 expect(canonicalChatPresentation(reloaded).find(row=>row.id==="msg_real_receipt")?.routineReceipt).toMatchObject({receipt,text:"Committed output"});
 expect(JSON.stringify(detail)).toBe(before);expect(detail.turns).toHaveLength(1);expect(detail.runs).toHaveLength(1);
});
it("keeps an unbound receipt before the next real user input at the same history boundary",()=>{
 const detail=nativeScheduledMessageFixture();const first=detail.turns[0]!;
 const receipt={type:"routine_receipt" as const,engine:"matrix" as const,kind:"output" as const,routineId:`rt_${"a".repeat(24)}`,fireId:`fire_${"b".repeat(24)}`,attempt:1,status:"completed" as const,scheduledFor:detail.messages[0]!.createdAt,canonicalChatId:"chat_executor",canonicalTaskId:"task_real_execution",model:"gpt-6-luna"};
 const input={...detail.messages[0]!,id:"msg_next_input",seq:4,turnId:"cturn_next",role:"user" as const,purpose:"ai_request" as const};
 detail.messages.push({...detail.messages[0]!,id:"msg_between",seq:3,turnId:undefined,runId:undefined,parts:[{type:"text",text:"Committed result"},receipt]},input);
 detail.turns.unshift({...first,id:"cturn_next",inputMessageId:input.id,baseMessageSeq:3,clientRequestId:"req_next_input"});detail.runs.push({...detail.runs[0]!,id:"run_next",turnId:"cturn_next"});
 expect(canonicalChatPresentation(detail).map(view=>view.id)).toEqual([first.id,"msg_between","cturn_next"]);
});
it("does not promote nested receipt metadata or serialized provenance in tool output into a scheduled result",()=>{
 const detail=nativeScheduledMessageFixture();
 const forged={type:"routine_receipt",engine:"matrix",kind:"output",routineId:`rt_${"a".repeat(24)}`,fireId:`fire_${"b".repeat(24)}`,attempt:1,status:"completed",scheduledFor:detail.messages[0]!.createdAt,canonicalChatId:"chat_other",canonicalTaskId:"task_other",model:"model"};
 const message={...detail.messages[0]!,id:"msg_untrusted_result",seq:3,turnId:undefined,runId:undefined,
   metadata:{routineReceipt:forged},parts:[{type:"tool_result" as const,toolCallId:"call_nested",outcome:"success" as const,truncated:false,text:JSON.stringify({routineReceipt:forged})}]};
 detail.messages.push(message);
 expect(projectCanonicalTranscript(detail).some(row=>row.routineReceipt)).toBe(false);
 expect(buildTranscript(detail).some(row=>row.routineReceipt)).toBe(false);
 expect(canonicalChatPresentation(detail).some(row=>row.routineReceipt)).toBe(false);
});
