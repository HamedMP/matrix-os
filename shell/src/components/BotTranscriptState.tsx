import { BotRunMessageBody, BotUnassignedMessageBody, RoutineOccurrenceMessage, RoutineMessageReadNotice, routineMessageTimeline, useRoutineMessageState, type RoutineOccurrence } from "@matrix-os/ui";
import {Fragment,useState,type ReactNode} from "react";
import type { ChatMessage, MessageGroup } from "@/lib/chat";

const messagesFor = (group: MessageGroup): ChatMessage[] => group.type === "message" ? [group.message] : group.messages;
export function botTranscriptPlacement(groups: MessageGroup[]) {
  // Snapshot-local and bounded; keep latest run slots if a legacy message window is oversized.
  const latest = new Map<string, number>();
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    for (const message of messagesFor(groups[index]!)) {
      if (message.requestId && !latest.has(message.requestId) && latest.size < 1_024) latest.set(message.requestId, index);
    }
  }
  const slots: string[][] = groups.map(() => []);
  for (const [runId, index] of latest) slots[index]!.push(runId);
  const requestIds = groups.flatMap(messagesFor).flatMap(message => {
    const request = message.metadata?.canonicalInput;
    return request && typeof request === "object" && "requestId" in request && typeof request.requestId === "string"
      && ("pending" in request && request.pending === true || "submitted" in request && request.submitted === true)
      && !("resolved" in request && request.resolved === true) ? [request.requestId] : [];
  });
  return { slots, runIds: [...latest.keys()], requestIds };
}
type Placement = ReturnType<typeof botTranscriptPlacement>;
/** One inline slot after the last row of each actual canonical run, including tool-only turns. */
export function BotTranscriptRunState({ placement, index }: { placement: Placement; index: number }) {
  const runIds = placement.slots[index] ?? [];
  if (!runIds.length) return null;
  return <div data-agent-message-body={runIds.join(" ")} className="min-w-0">
    <BotRunMessageBody runIds={runIds} requestIds={placement.requestIds}/>
  </div>;
}
export function BotTranscriptFallback({ placement }: { placement: Placement }) {
  return <BotUnassignedMessageBody runIds={placement.runIds} requestIds={placement.requestIds}/>;
}

/** Composition only: canonical input metadata binds the marker; missing fires get message rows. */
export function BotTranscriptMessages({groups,children}:{groups:MessageGroup[];children:(group:MessageGroup,index:number,scheduled?:RoutineOccurrence)=>ReactNode}){
  const state=useRoutineMessageState();
  const rows=routineMessageTimeline(groups,state?.occurrences??[],group=>group.type==="message"&&group.message.role==="user"?group.message.metadata?.routineRequestId:undefined,
    group=>group.type==="message"?group.message.timestamp:group.messages[0]!.timestamp);
  return <>{rows.map(row=>row.kind==="occurrence"?<RoutineOccurrenceMessage key={`scheduled:${row.occurrence.fire.fireId}`} occurrence={row.occurrence}/>
    :<Fragment key={row.value.type==="message"?row.value.message.id:row.value.messages[0]!.id}>{children(row.value,groups.indexOf(row.value),row.occurrence)}</Fragment>)}<RoutineMessageReadNotice/></>;
}

/** An unadmitted fire is content even when the server has not admitted any Chat turns. */
export function BotTranscriptLayout({empty,children}:{empty:boolean;children:(empty:boolean)=>ReactNode}){
  const state=useRoutineMessageState();
  return children(empty&&!(state?.occurrences.length));
}

export function BotScheduledInputText({text,scheduled}:{text:string;scheduled:boolean}){
  const [expanded,setExpanded]=useState(false);
  const long=scheduled&&(text.length>200||text.split("\n").length>3);
  return <><span className={`whitespace-pre-wrap break-words ${long&&!expanded?"line-clamp-3":""}`}>{text}</span>
    {long?<button type="button" aria-expanded={expanded} className="mt-2 text-sm text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2" onClick={()=>setExpanded(value=>!value)}>{expanded?"Show less":"Show more"}</button>:null}</>;
}
