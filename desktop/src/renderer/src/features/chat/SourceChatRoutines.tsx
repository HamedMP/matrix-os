import {useLayoutEffect,useRef,useState} from "react";
import {RoutineOriginApprovals,useRoutineOrigin,type ChatAgentClient} from "@matrix-os/ui";
import type {CanonicalChatSummary} from "@matrix-os/contracts";
import {routineFullAccessChatPresentationEligible} from "@matrix-os/ui";
import {routineOriginBrowserUrl} from "@matrix-os/ui/routine-origin";
import {desktopRoutineConfirmationDestination} from "./routine-action-confirmation";
import {invoke} from "../../lib/operator";
async function openDesktopRoutineApproval(chatId:string,interactionId:string,signal:AbortSignal) {
 signal.throwIfAborted();
 const target=await desktopRoutineConfirmationDestination();
 const url=routineOriginBrowserUrl(target.connection.platformHost,target.computer.gatewayPath,chatId,interactionId);
 signal.throwIfAborted();
 if(!target.current())throw new Error("Chat context changed");
 await invoke("shell:open-external",{url});
}
/** Native clients review an existing source-Chat approval in the owner browser. */
export function SourceChatRoutines({client,chat,ordinary,revision}:{client?:ChatAgentClient;chat?:CanonicalChatSummary;ordinary:boolean;revision:number}) {
 const eligible=routineFullAccessChatPresentationEligible({chat,ordinary,fresh:true});
 const state=useRoutineOrigin({client:client?.bots?.routineOrigin,chatId:chat?.id,eligible,revision});
 const lifetime=useRef<AbortController|null>(null);
 useLayoutEffect(()=>{const controller=new AbortController();lifetime.current=controller;return()=>{lifetime.current=null;controller.abort();};},[client,chat?.id,eligible]);
 const [message,setMessage]=useState("");
 const open=async(interactionId:string)=>{
  const signal=lifetime.current?.signal;
  if(!chat||!eligible||!signal)return;
  try{
   await openDesktopRoutineApproval(chat.id,interactionId,signal);
   if(!signal.aborted)setMessage("Continue in your browser to review this scheduled task.");
  }catch(error:unknown){
   console.warn("[routine-origin] Browser unavailable",error instanceof Error?error.name:"UnknownError");
   if(!signal.aborted)setMessage("The browser could not be opened. Try again.");
  }
 };
 if(!eligible)return null;
 return <><RoutineOriginApprovals state={state} onReviewInBrowser={id=>void open(id)}/>{message?<p role="status" className="text-xs">{message}</p>:null}</>;
}
