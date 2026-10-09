import {mkdtemp,mkdir,rm,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {createRuntimeAppAiRoutes} from "../../packages/gateway/src/app-ai/runtime.js";
vi.mock("../../packages/gateway/src/request-principal.js",()=>({requireRequestPrincipal:()=>({userId:"owner"})}));
let homePath:string;
beforeEach(async()=>{homePath=await mkdtemp(join(tmpdir(),"app-settings-composed-"));await mkdir(join(homePath,"system"));});
afterEach(async()=>{await rm(homePath,{recursive:true,force:true});await rm(homePath+"-private",{recursive:true,force:true});});
it("requests actual native identity without usage from the composed Settings store",async()=>{
  await writeFile(join(homePath,".claude.json"),JSON.stringify({oauthAccount:{accountUuid:"synthetic-owner"}}));
  const {AiProviderService}=await import("../../packages/gateway/src/ai-providers/service.js");
  const {ProviderSettingsStore}=await import("../../packages/gateway/src/ai-providers/provider-settings-store.js");
  const {createClaudeNativeAccountMetadataReader}=await import("../../packages/gateway/src/ai-providers/claude-native-account-metadata.js");
  const service=new AiProviderService({homePath,env:{},exposeClaudeProfileAccount:true,driverInventory:async()=>[{id:"claude_code",displayName:"Claude",kind:"cli",installState:"installed",health:"ready",setupActions:[],capabilities:["tools","resume"]}]});
  const usage=vi.fn(async()=>null);
  const metadata=createClaudeNativeAccountMetadataReader({executable:"claude",cwd:homePath,environment:{HOME:homePath},runCommand:async()=>({stdout:JSON.stringify({loggedIn:true,email:"owner@example.invalid",authMethod:"claude.ai",apiProvider:"firstParty",configDirectory:join(homePath,".claude")})}),usageReader:usage});
  const store=new ProviderSettingsStore({homePath,privateRootPath:homePath+"-private",providerSnapshotReader:service,claudeNativeAccountMetadataReader:metadata});
  await store.getSnapshot({includeNativeAccountMetadata:true,includeNativeAccountUsage:false});
  const {readSavedProviderSettingsConfiguration,writeProviderJsonAtomic}=await import("../../packages/gateway/src/ai-providers/provider-settings-persistence.js");
  const configuration=(await readSavedProviderSettingsConfiguration(store.configurationPath))!;
  Object.assign(configuration.harnesses[0]!,{selectedAccountId:"owner_claude_profile",accessSourceId:"owner_claude_profile",enabled:true,enablementOrigin:"owner_configuration"});
  await writeProviderJsonAtomic(store.configurationPath,configuration);
  await writeFile(join(homePath,"system/app-ai.json"),JSON.stringify({apps:["brain"]}));
  const settingsRead=vi.spyOn(store,"getSnapshot");const canonicalRead=vi.spyOn(service,"getSnapshot");
  try{
    const api=createRuntimeAppAiRoutes({homePath,ownerIds:["owner"],providerSnapshotReader:service,providerSettingsReader:store,nativeProfileGuard:{acquire:vi.fn()} as never});
    const response=await api.request("/routes?app=brain");expect(response.status).toBe(200);
    expect((await response.json()).routes).toContainEqual(expect.objectContaining({accessSourceId:"owner_claude_profile",availability:"available"}));
    expect(settingsRead).toHaveBeenCalledWith(expect.objectContaining({includeNativeAccountMetadata:true,includeNativeAccountUsage:false,signal:expect.any(AbortSignal)}));
    expect(canonicalRead.mock.calls.some(([options])=>options?.signal instanceof AbortSignal)).toBe(true);
    expect(usage).not.toHaveBeenCalled();
  }finally{service.close();}
});
