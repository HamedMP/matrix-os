import type {BotRoutineCenterItem, BotRoutineDetailResponse} from "@matrix-os/contracts";

export type RoutineOccurrence = {
  routine: BotRoutineCenterItem;
  fire: BotRoutineDetailResponse["history"][number];
};

/** Display correlation only. A matching durable owner-scoped fire is still required. */
export function routineRequestFireId(requestId: unknown): string | undefined {
  return typeof requestId === "string" ? /^req_routine_(fire_[a-f0-9]{24})(?:_a[23])?$/.exec(requestId)?.[1] : undefined;
}

export type RoutineTimelineItem<T> = {kind:"message"; value:T; occurrence?:RoutineOccurrence} | {kind:"occurrence"; occurrence:RoutineOccurrence};

/** Preserve existing message order. Only unmatched saved occurrences are inserted by time. */
export function routineMessageTimeline<T>(messages: readonly T[], occurrences: readonly RoutineOccurrence[], requestId:(message:T)=>unknown, timestamp:(message:T)=>number, descending=false): RoutineTimelineItem<T>[] {
  const rows: RoutineTimelineItem<T>[] = messages.map(value=>({kind:"message", value,
    occurrence:occurrences.find(row=>row.fire.fireId===routineRequestFireId(requestId(value)))}));
  const missing=occurrences.filter(row=>!messages.some(message=>routineRequestFireId(requestId(message))===row.fire.fireId))
    .sort((a,b)=>(Date.parse(a.fire.scheduledFor)-Date.parse(b.fire.scheduledFor))*(descending?-1:1));
  for(const occurrence of missing){
    const at=Date.parse(occurrence.fire.scheduledFor);
    const index=rows.findIndex(row=>{
      const time=row.kind==="message"?timestamp(row.value):Date.parse(row.occurrence.fire.scheduledFor);
      return descending?time<at:time>at;
    });
    rows.splice(index<0?rows.length:index,0,{kind:"occurrence",occurrence});
  }
  return rows;
}

export function routineOccurrenceTime(occurrence:RoutineOccurrence): string {
  // Match the reader's Chat timestamps; today's edited definition is not historical timezone data.
  return new Intl.DateTimeFormat(undefined,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"}).format(new Date(occurrence.fire.scheduledFor));
}

export function routineOccurrenceOutcome({fire}:RoutineOccurrence): string {
  if(fire.status==="failed")return fire.attempts===0?"Scheduled task did not run":"Scheduled task failed";
  if(fire.status==="uncertain")return "The outcome is unknown. Review this task before trying again; it will not be replayed automatically.";
  if(fire.status==="cancelled")return "Scheduled task cancelled";
  if(fire.status==="completed")return "Scheduled task completed";
  return fire.status==="claimed"?"Scheduled task is starting…":"Scheduled task is running…";
}
