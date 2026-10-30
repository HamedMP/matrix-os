import {Hono,type Context} from "hono";
import {z} from "zod/v4";
import {PreviewPairHandleSchema} from "@matrix-os/contracts/preview-pair";
import {getActivePreviewMachineByHandle} from "../customer-vps-preview.js";
import {getHostBundleRelease,type PlatformDB} from "../db.js";
const Params=z.strictObject({handle:PreviewPairHandleSchema,releaseFile:z.string().regex(/^[A-Za-z0-9._-]{1,128}\.json$/)});
const missing=(c:Context)=>c.json({error:"Not found"},404);
/** Public immutable metadata only. Neither release metadata nor this route grants access. */
export function createPreviewPairUpdateRoutes(options:{db:PlatformDB;hostBundleRoutes:Hono;logRouteError:(route:string,error:unknown)=>void}){
 const app=new Hono();
 app.use("*",async(c,next)=>{c.header("cache-control","no-store");c.header("cdn-cache-control","no-store");await next();});
 app.get("/:handle/system-bundles/releases/:releaseFile",async c=>{
  const parsed=Params.safeParse({handle:c.req.param("handle"),releaseFile:c.req.param("releaseFile")});if(!parsed.success)return missing(c);
  const {handle,releaseFile}=parsed.data,version=releaseFile.slice(0,-5);
  try{
   const machine=await getActivePreviewMachineByHandle(options.db,handle);
   if(!machine||machine.runtimeSlot!==handle||machine.accessClerkUserIds.length||!["provisioning","running"].includes(machine.status)
    ||machine.confirmedBundleVersion!==version||machine.targetBundleVersion!==version||machine.imageVersion!==version)return missing(c);
   const release=await getHostBundleRelease(options.db,version);
   if(!release||release.channel!==null||release.sourcePr!==Number(handle.split("-")[1])||release.sha256!==machine.targetBundleSha256)return missing(c);
   const response=await options.hostBundleRoutes.request(`/releases/${releaseFile}`);
   const headers=new Headers(response.headers);headers.set("cache-control","no-store");headers.set("cdn-cache-control","no-store");
   return new Response(response.body,{status:response.status,headers});
  }catch(error:unknown){options.logRouteError("/preview-pair-updates/:handle/system-bundles/releases",error);return c.json({error:"Host bundle unavailable"},502);}
 });
 app.all("*",missing);return app;
}
