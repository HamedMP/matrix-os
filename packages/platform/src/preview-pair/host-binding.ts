import {PreviewPairHandleSchema,PreviewPairOriginSchema} from "@matrix-os/contracts/preview-pair";
/** Internal dispatcher context only; no URL/command overrides in provisioning payloads. */
export function previewPairHostBinding(handle:string,slot:string,apiOrigin:string,browserOrigin:string|undefined){
 PreviewPairHandleSchema.parse(handle);PreviewPairOriginSchema.parse(apiOrigin);PreviewPairOriginSchema.parse(browserOrigin);
 const [, ,pair,generation]=handle.split("-");
 if(slot!==handle||!new URL(apiOrigin).hostname.startsWith(`cp-${pair}-g${generation}-api---`)
  ||browserOrigin!==apiOrigin.replace("-api---","-ui---"))throw new Error("Preview pair is unavailable");
 return {updateManifestBaseUrlEnv:`MATRIX_UPDATE_MANIFEST_BASE_URL=${apiOrigin}/preview-pair-updates/${handle}`,
  collaborationPairEnv:[`COLLABORATION_RELAY_ORIGIN=${browserOrigin}`,`MATRIX_COLLABORATION_CLIENT_ORIGINS=${browserOrigin}`].join("\n      ")};
}
