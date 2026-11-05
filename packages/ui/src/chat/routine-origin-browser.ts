import {BotInteractionIdSchema,CanonicalChatIdSchema,routineActionConfirmationUrl} from "@matrix-os/contracts";
/** Carries selectors only. No prompt, creation choice, proof, token or decision goes in a URL. */
export function routineOriginBrowserUrl(appOrigin:string,gatewayPath:string,chatId:string,interactionId?:string):string {
 const url=new URL(routineActionConfirmationUrl(appOrigin,gatewayPath,`rcact_${"0".repeat(32)}`));url.searchParams.delete("challenge");
 if(interactionId){url.searchParams.set("originChat",CanonicalChatIdSchema.parse(chatId));url.searchParams.set("interaction",BotInteractionIdSchema.parse(interactionId));}
 else {url.pathname=url.pathname.replace(/\/routine-cli\/confirm$/,"");url.searchParams.set("sourceChat",CanonicalChatIdSchema.parse(chatId));url.searchParams.set("launch","__chat__");}
 return url.toString();
}
export function sourceChatFromSearch(search:string):string|undefined {
 const params=new URLSearchParams(search),values=params.getAll("sourceChat");if(values.length!==1||params.getAll("launch").length!==1||params.get("launch")!=="__chat__"||
   params.getAll("runtime").length>1||(params.has("runtime")&&!/^[A-Za-z0-9_-]{1,32}$/.test(params.get("runtime")!))||
   [...params.keys()].some(key=>!["launch","sourceChat","runtime"].includes(key)))return;
 const result=CanonicalChatIdSchema.safeParse(values[0]);return result.success?result.data:undefined;
}
