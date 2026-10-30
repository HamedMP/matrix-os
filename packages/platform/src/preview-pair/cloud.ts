import {z} from "zod/v4";
import {PreviewPairOriginSchema,PreviewPairShaSchema} from "@matrix-os/contracts/preview-pair";
import type {EnabledPreviewPairConfig} from "./config.js";
import {PreviewPairUpstreamError,readPreviewPairJson} from "./http.js";
const Slug=z.string().max(80).regex(/^[a-z][a-z0-9-]+$/);
const Env=z.object({name:z.string().max(128),value:z.string().max(16384).optional(),
  valueSource:z.object({secretKeyRef:z.object({secret:z.string().max(256),version:z.string().regex(/^[1-9][0-9]{0,18}$/)})}).optional()});
const Ready=z.object({type:z.literal("Ready"),state:z.literal("CONDITION_SUCCEEDED")});
const Revision=z.object({name:z.string(),service:z.string(),reconciling:z.literal(false).optional(),conditions:z.array(z.object({type:z.string(),state:z.string()})).max(16),serviceAccount:z.string(),
  containers:z.array(z.object({image:z.string().regex(/@sha256:[a-f0-9]{64}$/),env:z.array(Env).max(128)})).length(1)});
const Service=z.object({name:z.string(),reconciling:z.literal(false).optional(),terminalCondition:Ready,trafficStatuses:z.array(z.object({
  tag:z.string().optional(),uri:z.string().optional(),revision:z.string(),percent:z.number().int().min(0).max(100).optional(),
})).max(128)});
/** IAM-authenticated immutable revision data; candidate HTTP is never evidence of its own isolation. */
export function createPreviewPairCloudAuthority(options:{config:EnabledPreviewPairConfig;project:string;region:string;service:string;
  approvedSecretRefs:string[];accessToken:()=>Promise<string>;fetchImpl?:typeof fetch;now?:()=>number}) {
  const {config}=options,project=Slug.parse(options.project),region=Slug.parse(options.region),service=Slug.parse(options.service);
  const allowed=z.array(z.string().max(96).regex(/^[a-z][a-z0-9-]+$/).refine(value=>value.includes("preview"))).min(3).max(16).parse(options.approvedSecretRefs);
  const resource=`projects/${project}/locations/${region}/services/${service}`,fetchImpl=options.fetchImpl??fetch;
  return async (browserOrigin:string,apiOrigin:string)=>{
    try {
      PreviewPairOriginSchema.parse(browserOrigin);PreviewPairOriginSchema.parse(apiOrigin);
      const token=await options.accessToken();if(!token||token.length>16384)throw new PreviewPairUpstreamError();
      const get=async(path:string)=>readPreviewPairJson(await fetchImpl(`https://run.googleapis.com/v2/${path}`,{
        headers:{Authorization:`Bearer ${token}`},redirect:"error",signal:AbortSignal.timeout(10_000),
      }));
      const live=Service.parse(await get(resource));if(live.name!==resource)throw new PreviewPairUpstreamError();
      const bindings=[browserOrigin,apiOrigin].map(origin=>{
        const matches=live.trafficStatuses.filter(item=>item.uri===origin&&item.tag===new URL(origin).hostname.split("---")[0]);
        if(matches.length!==1||(matches[0]!.percent??0)!==0)throw new PreviewPairUpstreamError();
        const ref=matches[0]!.revision;
        const name=ref.startsWith(`${resource}/revisions/`)?ref.slice(`${resource}/revisions/`.length):ref;
        if(!/^[a-z][a-z0-9-]{1,127}$/.test(name)||!name.startsWith(`${service}-`))throw new PreviewPairUpstreamError();
        return name;
      });
      if(bindings[0]!==bindings[1])throw new PreviewPairUpstreamError();
      const revision=Revision.parse(await get(`${resource}/revisions/${bindings[0]}`));
      if(!revision.conditions.some(condition=>Ready.safeParse(condition).success)||revision.name!==`${resource}/revisions/${bindings[0]}`||(revision.service!==resource&&revision.service!==service)||revision.serviceAccount!==config.serviceAccount)throw new PreviewPairUpstreamError();
      const entries=revision.containers[0]!.env;
      if(new Set(entries.map(entry=>entry.name)).size!==entries.length)throw new PreviewPairUpstreamError();
      for(const entry of entries){
        if(/^(HETZNER_API_TOKEN|GITHUB_TOKEN|GH_TOKEN|GITHUB_APP_PRIVATE_KEY|GOOGLE_APPLICATION_CREDENTIALS|MATRIX_PREVIEW_PAIR_OPERATOR_SECRET|GOLDEN_SNAPSHOT_OPERATOR_SECRET)$/.test(entry.name))throw new PreviewPairUpstreamError();
        if(entry.valueSource){
          if(entry.value!==undefined)throw new PreviewPairUpstreamError();
          const raw=entry.valueSource.secretKeyRef.secret;
          const ref=raw.startsWith(`projects/${project}/secrets/`)?raw.slice(`projects/${project}/secrets/`.length):raw;
          if(!allowed.includes(ref))throw new PreviewPairUpstreamError();
        }
      }
      const literal=(name:string)=>{const entry=entries.find(item=>item.name===name);if(!entry||entry.valueSource||entry.value===undefined)throw new PreviewPairUpstreamError();return entry.value;};
      const secret=(name:string,expected:string)=>{
        const entry=entries.find(item=>item.name===name),ref=entry?.valueSource?.secretKeyRef.secret;
        if(entry?.value!==undefined||(ref!==expected&&ref!==`projects/${project}/secrets/${expected}`))throw new PreviewPairUpstreamError();return expected;
      };
      for(const name of ["PLATFORM_SECRET","PLATFORM_JWT_SECRET","EDGE_ROUTER_SECRET"]){
        const entry=entries.find(item=>item.name===name);
        if(!entry?.valueSource||entry.value!==undefined)throw new PreviewPairUpstreamError();
      }
      const hosts=literal("MATRIX_APP_DOMAIN_HOSTS").split(",");
      if(hosts.length>8||!hosts.includes(new URL(browserOrigin).hostname)||hosts.includes(new URL(apiOrigin).hostname)
        ||literal("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY")!==config.clerkPublishableKey||literal("MATRIX_PREVIEW_PAIR_ENABLED")!=="false")throw new PreviewPairUpstreamError();
      return {browserOrigin,apiOrigin,identityIssuer:config.identityIssuer,sourceSha:PreviewPairShaSchema.parse(literal("MATRIX_BUILD_SHA")),
        serviceAccount:revision.serviceAccount,clerkSecretRef:secret("CLERK_SECRET_KEY",config.clerkSecretRef),
        databaseSecretRef:secret("PLATFORM_DATABASE_URL",config.databaseSecretRef),ticketKeysSecretRef:secret("MATRIX_COLLABORATION_TICKET_KEYS",config.ticketKeysSecretRef),
        appDomainHosts:hosts,browserRevision:bindings[0],apiRevision:bindings[1],observedAt:new Date(options.now?.()??Date.now()).toISOString()};
    }catch(error:unknown){console.warn("[preview-pair] authority unavailable",error instanceof Error?error.name:"UnknownError");throw new PreviewPairUpstreamError();}
  };
}
