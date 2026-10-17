import { z } from "zod/v4";
import { createSharedBrowserBroker, type SharedBrowserDriver } from "./broker.js";
import { createSharedBrowserCdpDriver } from "./cdp-driver.js";
import { writeBrowserArtifactManifest } from "./artifact-manifest.js";

const Acknowledgement=z.object({humanControlAvailable:z.boolean()}).strict();
/** Fixed owner/VPS composition. No model-supplied endpoint or owner is accepted. */
export function createSharedBrowserRuntime(options:{
  homePath:string;enabled:boolean;ownerId?:string;clerkOwnerId?:string;
  driver?:SharedBrowserDriver;fetcher?:typeof fetch;
}) {
  if(!options.enabled || !options.ownerId || options.ownerId!==options.clerkOwnerId)return undefined;
  const broker=createSharedBrowserBroker({ownerId:options.ownerId,
    driver:options.driver ?? createSharedBrowserCdpDriver({homePath:options.homePath}),
    exportArtifacts:(id,artifacts)=>writeBrowserArtifactManifest(options.homePath,id,artifacts),
    async setHumanControl(enabled){
      const response=await (options.fetcher??fetch)("http://127.0.0.1:8730/automation-input",{
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled}),
        signal:AbortSignal.timeout(5000),redirect:"error",
      });
      if(!response.ok || !response.body){await response.body?.cancel();throw new Error("Input gate unavailable");}
      const reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>256){await reader.cancel();throw new Error("Input gate unavailable");}chunks.push(value);}}
      finally{reader.releaseLock();}
      const result=Acknowledgement.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if(result.humanControlAvailable!==enabled)throw new Error("Input gate unavailable");
    },
  });
  return{broker,close:broker.close};
}
