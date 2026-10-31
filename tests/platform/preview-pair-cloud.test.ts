import {describe,expect,it,vi} from "vitest";
import {previewPairProvenanceFixture} from "./preview-pair-provenance-fixture.js";
import * as cloud from "../../packages/platform/src/preview-pair/cloud.js";
function setup(fault?:string){
  const f=previewPairProvenanceFixture(),resource="projects/pair-test/locations/europe-west1/services/matrix-platform-preview",revision=resource+"/revisions/matrix-platform-preview-pair";
  const tag=(origin:string)=>new URL(origin).hostname.split("---")[0];
  const service={name:resource,terminalCondition:{type:"Ready",state:"CONDITION_SUCCEEDED"},trafficStatuses:[{tag:tag(f.input.browserOrigin),uri:f.input.browserOrigin,revision,percent:0},{tag:tag(f.input.apiOrigin),uri:f.input.apiOrigin,revision,percent:0}]};
  const secret=(name:string,ref:string)=>({name,valueSource:{secretKeyRef:{secret:ref,version:"1"}}});
  const env:any[]=[{name:"MATRIX_BUILD_SHA",value:f.input.sourceSha},{name:"MATRIX_APP_DOMAIN_HOSTS",value:new URL(f.input.browserOrigin).hostname},
    {name:"NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",value:f.config.clerkPublishableKey},{name:"MATRIX_PREVIEW_PAIR_ENABLED",value:"false"},
    secret("CLERK_SECRET_KEY",f.config.clerkSecretRef),secret("PLATFORM_DATABASE_URL",f.config.databaseSecretRef),secret("MATRIX_COLLABORATION_TICKET_KEYS",f.config.ticketKeysSecretRef),secret("PLATFORM_SECRET","platform-secret-preview"),secret("PLATFORM_JWT_SECRET","platform-jwt-preview"),secret("EDGE_ROUTER_SECRET","edge-router-preview")];
  const rev={name:revision,service:"matrix-platform-preview",conditions:[{type:"Ready",state:"CONDITION_SUCCEEDED"}],serviceAccount:f.config.serviceAccount,containers:[{image:`registry.example/pair@sha256:${"d".repeat(64)}`,env}]};
  if(fault==="account")rev.serviceAccount="production@example.iam.gserviceaccount.com";
  if(fault==="database")env[5].valueSource.secretKeyRef.secret="production-database";
  if(fault==="api classified")env[1].value+=","+new URL(f.input.apiOrigin).hostname;
  if(fault==="retarget")service.trafficStatuses[1].revision=resource+"/revisions/different";
  if(fault==="provider secret")env.push(secret("HETZNER_API_TOKEN","hetzner-preview-token"));
  if(fault==="mutable secret")env[4].valueSource.secretKeyRef.version="latest";
  if(fault==="source")env[0].value="not-a-sha";
  if(fault==="not ready")rev.conditions[0].state="CONDITION_FAILED";
  if(fault==="raw signing secret")env[8]={name:"PLATFORM_JWT_SECRET",value:"production-key"};
  if(fault==="missing signing secret")env.splice(8,1);
  if(fault==="reconciling")Object.assign(rev,{reconciling:true});
  if(fault==="mounted production secret"||fault==="mounted approved secret"){
   Object.assign(rev,{volumes:[{name:"file-secret",secret:{secret:fault==="mounted production secret"?"production-secret":f.config.clerkSecretRef,items:[{path:"secret",version:"1"}]}}]});
   Object.assign(rev.containers[0],{volumeMounts:[{name:"file-secret",mountPath:"/etc/secrets"}]});
  }
  if(fault==="sidecar")rev.containers.push({image:"other",env:[]});
  const fetchImpl=vi.fn(async (url:any)=>Response.json(String(url).endsWith("/revisions/matrix-platform-preview-pair")?rev:service));
  return {f,fetchImpl,read:(cloud as any).createPreviewPairCloudAuthority({config:f.config,project:"pair-test",region:"europe-west1",service:"matrix-platform-preview",approvedSecretRefs:[f.config.clerkSecretRef,f.config.databaseSecretRef,f.config.ticketKeysSecretRef,"platform-secret-preview","platform-jwt-preview","edge-router-preview"],accessToken:async()=>"iam-fixture",fetchImpl,now:()=>Date.parse("2026-10-30T10:00:00Z")})};
}
describe("actual Cloud Run revision isolation reader",()=>{
  it("binds two generation tags to one immutable approved revision",async()=>{
    const {f,read,fetchImpl}=setup();expect(await read(f.input.browserOrigin,f.input.apiOrigin)).toMatchObject({sourceSha:f.input.sourceSha,serviceAccount:f.config.serviceAccount,clerkSecretRef:f.config.clerkSecretRef});
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each(["account","database","api classified","retarget","provider secret","mutable secret","source","sidecar","not ready","raw signing secret","missing signing secret","reconciling","mounted production secret","mounted approved secret"])("fails closed for %s bindings",async fault=>{
    const {f,read}=setup(fault);await expect(read(f.input.browserOrigin,f.input.apiOrigin)).rejects.toThrow("unavailable");
  });
});
