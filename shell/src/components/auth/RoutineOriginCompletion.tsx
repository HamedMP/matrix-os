"use client";
import {useMemo} from "react";
import {createRoutineOriginClient,RoutineOriginApprovals,useRoutineOrigin} from "@matrix-os/ui";
import {createOwnerBrowserJsonRequest} from "@matrix-os/ui/routine-origin";
import {getGatewayUrl} from "@/lib/gateway";
/** The browser reads the current exact canonical review; mounting never submits a decision. */
export function RoutineOriginCompletion({chatId,interactionId,getToken,identity}:{chatId:string;interactionId:string;getToken:()=>Promise<string|null>;identity:string}) {
 const gateway=getGatewayUrl();
 const scope=useMemo(()=>({gateway,identity}),[gateway,identity]);
 const client=useMemo(()=>{const request=createOwnerBrowserJsonRequest(scope.gateway,getToken,fetch,{cache:"no-store",allowRelative:true});return createRoutineOriginClient((path,method,body,options)=>request({path,method,body,signal:options?.signal}));},[scope,getToken]);
 const state=useRoutineOrigin({client,chatId,eligible:true});
 const filtered={...state,view:state.view?{...state.view,pending:state.view.pending.filter(item=>item.interaction.interactionId===interactionId)}:null};
 return <><RoutineOriginApprovals state={filtered}/>{state.fresh&&!filtered.view?.pending.length?<p role="status">This review is closed or unavailable. Return to the source Chat to check current status.</p>:!state.view&&!state.error?<p role="status">Loading scheduled task review…</p>:null}</>;
}
