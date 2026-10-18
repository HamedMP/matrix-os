import type { GroupBotRevocation } from "../../packages/gateway/src/bots/admission.js";
import {describe,it,expect,vi} from "vitest";
import { createSharedBotModelRouteResolver } from "../../packages/gateway/src/bots/codex-route.js";
import { MATRIX_BOT_SELECTION } from "../../packages/contracts/src/index.js";
import {createCompanyBotRuntime} from "../../packages/gateway/src/startup/company-bot-runtime.js";
const scopeId="8047da35-382b-437c-8047-28bb5f59b52b";
function setup(getGroupRevocation?: () => GroupBotRevocation | undefined, resolver?: ReturnType<typeof createSharedBotModelRouteResolver>){
  const source={accessSourceId:"owner_anthropic_key",providerInstanceId:"claude_default",harness:"claude_code",modelId:"claude-test"};
  const record={scopeId,chatId:"chat_company",status:"running",binding:{runId:"run_test",requestingActorId:"user_employee",executingOwnerId:"user_host",
    source,policyRevision:"4",sessionGeneration:"2",executionRoot:{kind:"project",projectId:"project_company"},rootFingerprint:"a".repeat(64)}};
  const policy={ownerId:"user_host",revision:"4",source,allowedModelIds:["claude-test"]};
  const decision={policyRevision:"4",harness:"claude_code",providerInstanceId:"claude_default",accessSourceId:"owner_anthropic_key",allowedModelIds:["claude-test"],effectiveSubmitMode:"members"};
  const authorize=vi.fn().mockResolvedValue({scopeId,actorId:"user_employee",ownerId:"user_host",resourceId:"chat_company",resourceKind:"chat",organizationId:"org_company",capability:"request_ai"});
  const resolveModel=vi.fn().mockResolvedValue({route:{modelId:"claude-test"},accessSourceId:"owner_anthropic_key"});
  if(resolver)resolveModel.mockImplementation(resolver);
  const runtime=createCompanyBotRuntime({ownerId:"user_host",modelId:"claude-test",loadRun:vi.fn().mockResolvedValue(record),
    authority:{authorize},policies:{resolve:vi.fn().mockResolvedValue(policy)},ownerSource:{prepare:vi.fn().mockResolvedValue(decision)},
    resolveModel,getGroupRevocation,getAdapter:()=>({driverKind:"matrix_bot"}) as never});
  return{runtime,record,policy,decision,authorize,resolveModel};
}
describe("company Pi policy wiring",()=>{
  it.each(["excluded_model", "unsupported_harness", "unsupported_source"] as const)("does not advertise a company route that rejects %s before admission", async mismatch => {
    const getSnapshot = vi.fn(async () => { throw new Error("Personal fallback must not be read"); });
    const resolver = createSharedBotModelRouteResolver({ providers: { getSnapshot }, resolveCodexIdentity: vi.fn() as never, lifetime: new AbortController().signal });
    const { runtime, decision } = setup(undefined, resolver);
    const exact = { ...decision, modelId: "claude-test" };
    if (mismatch === "excluded_model") exact.allowedModelIds = [];
    if (mismatch === "unsupported_harness") exact.harness = "codex";
    if (mismatch === "unsupported_source") exact.accessSourceId = null as never;
    const ready = await Reflect.apply(runtime.matrixBot.readiness!, runtime.matrixBot, ["user_host", MATRIX_BOT_SELECTION, exact]);
    expect(ready).toBe("unavailable");
    expect(getSnapshot).not.toHaveBeenCalled();
  });
  it("checks the exact scope decision and configured company model before reporting ready", async () => {
    const { runtime, decision, resolveModel } = setup();
    const exact = { ...decision, modelId: "claude-test" };
    expect(await Reflect.apply(runtime.matrixBot.readiness!, runtime.matrixBot, ["user_host", MATRIX_BOT_SELECTION, exact])).toBe("ready");
    expect(resolveModel).toHaveBeenCalledExactlyOnceWith(exact, "claude-test");
  });
  it("resolves the same live revocation state lazily through typed startup injection",()=>{
    let current: GroupBotRevocation | undefined;
    const {runtime}=setup(()=>current);expect(runtime.getGroupRevocation()).toBeUndefined();
    current={runtimes:{bind:()=>undefined,release:()=>undefined},revocations:{isRevoked:()=>false}};
    expect(runtime.getGroupRevocation()).toBe(current);
  });
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
