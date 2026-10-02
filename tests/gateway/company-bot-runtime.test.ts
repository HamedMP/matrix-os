import {describe,it,expect,vi} from "vitest";
import {createCompanyBotRuntime} from "../../packages/gateway/src/startup/company-bot-runtime.js";
const scopeId="8047da35-382b-437c-8047-28bb5f59b52b";
function setup(){
  const source={accessSourceId:"owner_anthropic_key",providerInstanceId:"claude_default",harness:"claude_code",modelId:"claude-test"};
  const record={scopeId,chatId:"chat_company",status:"running",binding:{runId:"run_test",requestingActorId:"user_employee",executingOwnerId:"user_host",
    source,policyRevision:"4",sessionGeneration:"2",executionRoot:{kind:"project",projectId:"project_company"},rootFingerprint:"a".repeat(64)}};
  const policy={ownerId:"user_host",revision:"4",source,allowedModelIds:["claude-test"]};
  const decision={policyRevision:"4",harness:"claude_code",providerInstanceId:"claude_default",accessSourceId:"owner_anthropic_key",allowedModelIds:["claude-test"],effectiveSubmitMode:"members"};
  const authorize=vi.fn().mockResolvedValue({scopeId,actorId:"user_employee",ownerId:"user_host",resourceId:"chat_company",resourceKind:"chat",organizationId:"org_company",capability:"request_ai"});
  const resolveModel=vi.fn().mockResolvedValue({route:{modelId:"claude-test"},accessSourceId:"owner_anthropic_key"});
  const runtime=createCompanyBotRuntime({ownerId:"user_host",modelId:"claude-test",loadRun:vi.fn().mockResolvedValue(record),
    authority:{authorize},policies:{resolve:vi.fn().mockResolvedValue(policy)},ownerSource:{prepare:vi.fn().mockResolvedValue(decision)},
    resolveModel,getAdapter:()=>({driverKind:"matrix_bot"}) as never});
  return{runtime,record,policy,decision,authorize,resolveModel};
}
describe("company Pi policy wiring",()=>{
  it("derives group identity and root only from canonical admitted run",async()=>{
    const {runtime,resolveModel}=setup();
    const group=await runtime.resolveGroupRun({ownerId:"user_host",chatId:"chat_company",runId:"run_test"});
    expect(group).toEqual({scopeId,actorId:"user_employee",sessionGeneration:"2",executionRoot:{kind:"project",projectId:"project_company"},executionRootFingerprint:"a".repeat(64)});
    await runtime.resolveGroupRoute({ownerId:"user_host",chatId:"chat_company",runId:"run_test",group});
    expect(resolveModel).toHaveBeenCalledWith(expect.objectContaining({policyRevision:"4"}),"claude-test");
  });
  it.each(["revision","source","model","actor","owner","chat","root"])("fails closed after %s changes",async(change)=>{
    const {runtime,record,policy}=setup();
    if(change==="revision")policy.revision="5";
    if(change==="source")policy.source={...policy.source,accessSourceId:"other"};
    if(change==="model")policy.allowedModelIds=[];
    if(change==="actor")record.binding.requestingActorId="user_other";
    if(change==="owner")record.binding.executingOwnerId="user_other";
    if(change==="chat")record.chatId="chat_other";
    if(change==="root")record.binding.executionRoot={kind:"bot_workspace",botId:"bot_private"} as never;
    await expect(runtime.authorizeGroup({scopeId,actorId:"user_employee",ownerId:"user_host",chatId:"chat_company",runId:"run_test"})).rejects.toThrow();
  });
});
