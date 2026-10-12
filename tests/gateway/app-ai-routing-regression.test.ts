import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import type {ProviderSettingsSnapshot,AiProviderSnapshotV3} from "@matrix-os/contracts";
import {createRuntimeAppAiRoutes} from "../../packages/gateway/src/app-ai/runtime.js";
vi.mock("../../packages/gateway/src/request-principal.js",()=>({requireRequestPrincipal:()=>({userId:"owner"})}));
let home:string;
beforeEach(async()=>{home=await mkdtemp(join(tmpdir(),"app-route-regression-"));await mkdir(join(home,"system"));await mkdir(join(home,".pi/agent"),{recursive:true});await writeFile(join(home,".pi/agent/auth.json"),JSON.stringify({openai:{type:"api_key",key:"selected-static-key"},anthropic:{type:"api_key",key:"unselected-key"}}));});
afterEach(async()=>{await rm(home,{recursive:true,force:true});});
function settings(count=1):ProviderSettingsSnapshot{
  const models=Array.from({length:count},(_,index)=>({id:`openai:model-${index}`,displayName:`Model${index}`,enabled:true}));
  return {harnesses:[{id:"pi_work",harness:"pi",displayName:"Pi Work",enabled:true,installState:"installed",authState:"authenticated",connectivity:"online",selectedAccountId:null,accessSourceId:"pi_openai",route:{kind:"configurable",providerId:"openai",modelId:models[0]!.id}}],accessSources:[{id:"pi_openai",kind:"harness_profile",harness:"pi",providerId:"openai",accountId:null,fundingKind:"harness_owned",eligibleModelIds:models.map(model=>model.id),readiness:{state:"ready",staleAfter:null}}],accounts:[],modelProviders:[{id:"openai",models}]} as ProviderSettingsSnapshot;
}
const managed={harnessId:"matrix_ai",accountId:null,accessSourceId:"matrix_cloudflare",modelId:"@cf/zai-org/glm-5.3-flash"};
function canonical():AiProviderSnapshotV3{return {instances:[{id:"managed_instance",driverId:"kernel",accountId:null}],active:{providerInstanceId:"managed_instance",accessSourceId:managed.accessSourceId,modelId:managed.modelId},accessSources:[{id:managed.accessSourceId,state:"ready",checkedAt:new Date().toISOString(),staleAfter:new Date(Date.now()+60000).toISOString(),eligibleModelIds:[managed.modelId]}],models:[{id:managed.modelId,status:"current",eligibleAccessSourceIds:[managed.accessSourceId]}]} as AiProviderSnapshotV3;}
function fundedSettings():ProviderSettingsSnapshot{
  const snapshot=settings();
  snapshot.harnesses[0]={...snapshot.harnesses[0]!,id:"active_opencode",harness:"opencode",accessSourceId:managed.accessSourceId,route:{kind:"configurable",providerId:"cloudflare",modelId:managed.modelId}};
  snapshot.accessSources=[{id:managed.accessSourceId,kind:"matrix_gateway",providerId:"cloudflare",accountId:null,fundingKind:"matrix_included",eligibleModelIds:[managed.modelId],readiness:{state:"ready",staleAfter:null}}] as never;
  snapshot.modelProviders=[{id:"cloudflare",displayName:"Cloudflare",models:[{id:managed.modelId,displayName:"GLM",enabled:true}]}];
  return snapshot;
}
it.each(["disabled same harness","enabled other harness"])("uses the active V3 driver when an %s has the same route tuple first",async competing=>{
  await writeFile(join(home,"system/app-ai.json"),JSON.stringify({apps:["notes"]}));
  const snapshot=fundedSettings();
  snapshot.harnesses.unshift({...snapshot.harnesses[0]!,id:"unselected_first",harness:competing==="disabled same harness"?"opencode":"pi",enabled:competing!=="disabled same harness"});
  const active=canonical();active.instances[0]={...active.instances[0]!,driverId:"opencode",accessSourceId:managed.accessSourceId,modelIds:[managed.modelId]};
  const fetchImpl=vi.fn(async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"active result"}}]}));
  const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:["owner"],providerSettingsReader:{getSnapshot:async()=>snapshot},providerSnapshotReader:{getSnapshot:async()=>active},fundedCredentialProvider:{enabled:true,getCredential:async()=>({token:"synthetic",relayBaseUrl:"https://relay.invalid"})} as never,fetchImpl});
  const discovery=await(await api.request("/routes?app=notes")).json();
  expect(discovery.defaultRoute).toEqual({...managed,harnessId:"active_opencode"});
  expect((await api.request("/",{method:"POST",body:JSON.stringify({app:"notes",prompt:"source"})})).status).toBe(200);
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("leaves the default unset when V3 cannot distinguish two enabled instances of its driver",async()=>{
  await writeFile(join(home,"system/app-ai.json"),JSON.stringify({apps:["notes"]}));
  const snapshot=fundedSettings();snapshot.harnesses.unshift({...snapshot.harnesses[0]!,id:"ambiguous_opencode"});
  const active=canonical();active.instances[0]={...active.instances[0]!,driverId:"opencode",accessSourceId:managed.accessSourceId,modelIds:[managed.modelId]};
  const getCredential=vi.fn();const fetchImpl=vi.fn();
  const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:["owner"],providerSettingsReader:{getSnapshot:async()=>snapshot},providerSnapshotReader:{getSnapshot:async()=>active},fundedCredentialProvider:{enabled:true,getCredential} as never,fetchImpl});
  const discovery=await(await api.request("/routes?app=notes")).json();expect(discovery.defaultRoute).toBeNull();
  expect(discovery.routes.filter((route:{availability:string})=>route.availability==="available")).toHaveLength(3);
  expect((await api.request("/",{method:"POST",body:JSON.stringify({app:"notes",prompt:"source"})})).status).toBe(503);
  expect(getCredential).not.toHaveBeenCalled();expect(fetchImpl).not.toHaveBeenCalled();
});
it("keeps the exact active route executable beyond the128-entry discovery page",async()=>{
  await writeFile(join(home,"system/app-ai.json"),JSON.stringify({apps:["notes"]}));
  const fetchImpl=vi.fn(async()=>Response.json({choices:[{finish_reason:"stop",message:{content:"managed result"}}]}));
  const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:["owner"],providerSettingsReader:{getSnapshot:async()=>settings(129)},providerSnapshotReader:{getSnapshot:async()=>canonical()},fundedCredentialProvider:{enabled:true,getCredential:async()=>({token:"synthetic",relayBaseUrl:"https://relay.invalid"})} as never,fetchImpl});
  const discovered=await(await api.request("/routes?app=notes")).json();
  expect(discovered.routes).toHaveLength(128);expect(discovered.defaultRoute).toEqual(managed);
  expect(discovered.routes).toContainEqual(expect.objectContaining(managed));
  const response=await api.request("/",{method:"POST",body:JSON.stringify({app:"notes",prompt:"source"})});
  expect(response.status).toBe(200);expect(await response.json()).toEqual({text:"managed result"});
  expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).model).toBe(managed.modelId);
});
it("runs an app POST through the exact SDK route beyond the capped discovery page",async()=>{
  await writeFile(join(home,"system/app-ai.json"),JSON.stringify({apps:["notes"]}));
  const generate=vi.fn(async(input:{providerId:string;modelId:string;prompt:string;revalidate:()=>Promise<boolean>})=>{
    expect(input.providerId).toBe("openai");expect(input.modelId).toBe("openai:model-128");expect(input.prompt).toBe("document");expect(await input.revalidate()).toBe(true);return{text:"only text"};
  });
  const piSdkCompletion={probe:async(input:{modelIds:string[]})=>input.modelIds,generate,close:vi.fn()};
  const api=createRuntimeAppAiRoutes({homePath:home,ownerIds:["owner"],providerSettingsReader:{getSnapshot:async()=>settings(129)},piSdkCompletion:piSdkCompletion as never});
  const route={harnessId:"pi_work",accountId:null,accessSourceId:"pi_openai",modelId:"openai:model-128"};
  const post=(selection:unknown)=>api.request("/",{method:"POST",body:JSON.stringify({app:"notes",prompt:"document",route:selection})});
  const response=await post(route);expect(response.status).toBe(200);expect(await response.json()).toEqual({text:"only text"});
  expect((await post({...route,accountId:"another-account"})).status).toBe(503);expect(generate).toHaveBeenCalledTimes(1);
});
