import {AiProviderSnapshotV3Schema} from "@matrix-os/contracts";
import {mkdtemp,mkdir,writeFile,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {createClaudeNativeAccountMetadataReader} from "../../../packages/gateway/src/ai-providers/claude-native-account-metadata.js";
import {ProviderSettingsStore} from "../../../packages/gateway/src/ai-providers/provider-settings-store.js";
import {createProviderSettingsRoutes} from "../../../packages/gateway/src/ai-providers/provider-settings-routes.js";
import {initialProviderSettingsConfiguration} from "../../../packages/gateway/src/ai-providers/provider-settings-persistence.js";
import {providerSettingsCanonicalFixture} from "../provider-settings-test-support.js";

/** Synthetic CLI status process, real reader/store/routes. Never accesses an owner's credentials. */
export async function createTerminalClaudeFixture(){
 const root=await mkdtemp(join(tmpdir(),"matrix-terminal-auth-")),home=join(root,"home");await mkdir(home);
 const statusPath=join(home,"fixture-status.json"),executable=join(root,"fixture-claude.cjs");
 await writeFile(executable,`#!${process.execPath}\nconst fs=require('node:fs');if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['auth','status','--json']))process.exit(2);const s=JSON.parse(fs.readFileSync(${JSON.stringify(statusPath)},'utf8'));if(s.failure)process.exit(2);process.stdout.write(JSON.stringify({...s,configDirectory:${JSON.stringify(join(home,'.claude'))}}));process.exitCode=s.loggedIn?0:1;`,{mode:0o700});
 const setStatus=async(email:string|null,failure=false)=>writeFile(statusPath,JSON.stringify({loggedIn:email!==null,authMethod:email?'claude.ai':'none',apiProvider:'firstParty',...(email?{email}:{}),failure}));
 await setStatus(null);
 const canonical=providerSettingsCanonicalFixture();
 const unknown={state:'unknown' as const,checkedAt:null,staleAfter:null,action:'retry' as const,safeReason:'unknown' as const};
 const original=canonical.accessSources.find(s=>s.id==='owner_anthropic_profile')!;Object.assign(original,unknown);
 canonical.accessSources.push({...original,id:'owner_claude_profile'});
 canonical.accounts.push({...canonical.accounts[0]!,id:'owner_claude_profile',authMethod:'provider_profile',...unknown});
 canonical.instances.push({...canonical.instances.find(i=>i.accessSourceId===original.id)!,id:'claude_code_owner_profile',driverId:'claude_code',accountId:'owner_claude_profile',accessSourceId:'owner_claude_profile',readiness:unknown,defaultModelId:null});
 for(const model of canonical.models)if(model.eligibleAccessSourceIds.includes(original.id)){
  model.eligibleAccessSourceIds.push('owner_claude_profile');model.dataPolicies.push({...model.dataPolicies.find(p=>p.accessSourceId===original.id)!,accessSourceId:'owner_claude_profile'});
 }
 AiProviderSnapshotV3Schema.parse({...canonical,refreshedAt:new Date().toISOString()});
 const store=new ProviderSettingsStore({homePath:home,privateRootPath:join(root,'private'),providerSnapshotReader:{getSnapshot:async()=>structuredClone({...canonical,refreshedAt:new Date().toISOString()})},
  claudeNativeAccountMetadataReader:createClaudeNativeAccountMetadataReader({executable,cwd:home,environment:{HOME:home,PATH:process.env.PATH??''},usageReader:async()=>null})});
 const config=initialProviderSettingsConfiguration(canonical),harness=config.harnesses.find(h=>h.harness==='claude')!;
 harness.id='harness_kernel';harness.enablementOrigin='owner_configuration';harness.enabled=false;harness.accessSourceId='owner_anthropic_profile';harness.selectedAccountId='owner_anthropic';
 await mkdir(dirname(store.configurationPath),{recursive:true});await writeFile(store.configurationPath,JSON.stringify(config));
 const routes=createProviderSettingsRoutes({store,getPrincipal:()=>({userId:'fixture-owner'}),canReadNativeAccountMetadata:()=>true});
 return {home,store,routes,setStatus,configuration:()=>readFile(store.configurationPath,'utf8'),close:()=>rm(root,{recursive:true,force:true})};
}
