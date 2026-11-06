import {createContext,useContext,type ReactNode} from "react";
import type {RoutineOccurrence} from "./routine-transcript.js";
import {routineOccurrenceOutcome} from "./routine-transcript.js";
import {ScheduledMessageMeta} from "../../chat/ScheduledMessageMeta.js";
import type {useRoutineMessages} from "./use-routine-messages.js";
import {chatAgentMutedStyle} from "../theme.js";

type State=ReturnType<typeof useRoutineMessages>;
export const RoutineMessageContext=createContext<State|null>(null);
export const useRoutineMessageState=()=>useContext(RoutineMessageContext);

/** The annotation belongs to the input bubble, never a Chat header/history panel. */
export function RoutineMessageMeta({occurrence,sent=true}:{occurrence:RoutineOccurrence;sent?:boolean}){
  return <ScheduledMessageMeta timestamp={occurrence.fire.scheduledFor} sent={sent}/>;
}

/** Standalone saved failures still occupy their own chronological transcript position. */
export function RoutineOccurrenceMessage({occurrence,children}:{occurrence:RoutineOccurrence;children?:ReactNode}){
  return <div data-message-id={`scheduled:${occurrence.fire.fireId}`} className="flex min-w-0 flex-col items-end gap-2 py-1">
    <RoutineMessageMeta occurrence={occurrence} sent={false}/>
    <div className="max-w-[min(85%,48rem)] rounded-2xl px-4 py-3 text-sm leading-relaxed" style={{background:"color-mix(in srgb, var(--text-primary) 7%, var(--bg-surface))"}}>
      <p>{routineOccurrenceOutcome(occurrence)}</p>
    </div>
    {children}
  </div>;
}

export function RoutineMessageReadNotice(){
  const state=useRoutineMessageState();
  return state?.failed?<p className="text-xs" role="status" style={chatAgentMutedStyle}>Scheduled task status could not be loaded. <button type="button" className="underline disabled:opacity-50" disabled={state.loading} onClick={state.retry}>Retry</button></p>
    :state?.incomplete?<p className="text-xs" style={chatAgentMutedStyle}>Scheduled task status is limited to the recent saved runs.</p>:null;
}
