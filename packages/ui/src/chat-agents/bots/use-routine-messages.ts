import {useEffect, useRef, useState} from "react";
import type {BotRoutineCenterItem, BotRoutineCenterQuery, BotRoutineDetailResponse} from "@matrix-os/contracts";
import type {BotRoutineClient} from "./routine-client.js";
import type {RoutineOccurrence} from "./routine-transcript.js";

const MAX_PAGES=4, MAX_TASKS_PER_KIND=32, MAX_RUNS=20, CONCURRENCY=4;
type Saved=BotRoutineDetailResponse;
type ReadResult={saved:Saved[]; occurrences:RoutineOccurrence[]; incomplete:boolean; failed:boolean};

/** Existing owner APIs only: at most8 pages/64 tasks/1280 recent occurrences; no mutation. */
export async function readRoutineMessages(api:BotRoutineClient,chatId:string,previous:readonly Saved[]=[],current=()=>true):Promise<ReadResult>{
  const tasks:BotRoutineCenterItem[]=[];
  let incomplete=false, failed=false, listFailed=false;
  for(const archived of [false,true]){
    let query:BotRoutineCenterQuery=archived?{archived:"true"}:{};
    let owned=0;
    for(let page=0;page<MAX_PAGES&&current();page++){
      try{
        const response=await api.list(query);
        if(!current())break;
        for(const row of response.items){
          if(row.chatId!==chatId||tasks.some(task=>task.routineId===row.routineId))continue;
          if(owned>=MAX_TASKS_PER_KIND){incomplete=true;break;}
          tasks.push(row);owned++;
        }
        if(!response.nextCursor)break;
        if(owned>=MAX_TASKS_PER_KIND||page===MAX_PAGES-1){incomplete=true;break;}
        query={...response.nextCursor,...(archived?{archived:"true" as const}:{})};
      }catch(error:unknown){
        console.warn("[routine-messages] List unavailable",error instanceof Error?error.name:"UnknownError");failed=true;listFailed=true;break;
      }
    }
  }
  const saved:Saved[]=[];
  let next=0;
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,tasks.length)},async()=>{
    while(next<tasks.length&&current()){
      const task=tasks[next++]!;
      const old=previous.find(row=>row.routine.routineId===task.routineId&&row.routine.chatId===chatId);
      if(old&&old.routine.revision===task.revision&&old.routine.lastFire?.updatedAt===task.lastFire?.updatedAt){if(old.history.length>=MAX_RUNS)incomplete=true;saved.push(old);continue;}
      try{
        const detail=await api.detail(task.routineId);
        if(detail.routine.chatId!==chatId||detail.routine.routineId!==task.routineId)throw new Error("Occurrence identity changed");
        if(detail.history.length>=MAX_RUNS)incomplete=true;
        if(current())saved.push({...detail,history:detail.history.slice(0,MAX_RUNS)});
      }catch(error:unknown){
        console.warn("[routine-messages] Detail unavailable",error instanceof Error?error.name:"UnknownError");
        failed=true;
        if(old&&current())saved.push(old);
      }
    }
  }));
  if(listFailed&&current())for(const old of previous.slice(0,MAX_TASKS_PER_KIND*2)){
    if(saved.length>=MAX_TASKS_PER_KIND*2)break;
    if(old.routine.chatId===chatId&&!tasks.some(task=>task.routineId===old.routine.routineId)&&!saved.some(row=>row.routine.routineId===old.routine.routineId))saved.push(old);
  }
  return{saved,occurrences:saved.flatMap(({routine,history})=>history.map(fire=>({routine,fire}))),incomplete,failed};
}

/** A fresh scope discards the bounded cache and fences all late reads. Polls never overlap. */
export function useRoutineMessages(api:BotRoutineClient|undefined,chatId:string|undefined,enabled=true){
  const [retry,setRetry]=useState(0);
  const [state,setState]=useState<(ReadResult&{api:BotRoutineClient;chatId:string;loading:boolean})|null>(null);
  const memory=useRef<{api:BotRoutineClient;chatId:string;saved:Saved[]}|null>(null);
  const pending=useRef<{api:BotRoutineClient;chatId:string}|null>(null);
  useEffect(()=>{
    if(!api||!chatId||!enabled)return;
    let current=true, timer:ReturnType<typeof setTimeout>|undefined;
    const scope={api,chatId};
    let cache=memory.current?.api===api&&memory.current.chatId===chatId?memory.current.saved:[];
    memory.current={...scope,saved:cache};
    const read=async()=>{
      pending.current=scope;
      setState(previous=>previous?.api===api&&previous.chatId===chatId?{...previous,loading:true}:{...scope,saved:[],occurrences:[],incomplete:false,failed:false,loading:true});
      const result=await readRoutineMessages(api,chatId,cache,()=>current);
      if(!current)return;
      if(pending.current===scope)pending.current=null;
      cache=result.saved;memory.current={...scope,saved:cache};setState({...result,api,chatId,loading:false});
      timer=setTimeout(()=>{void read();},15_000);
    };
    void read();
    return () => {
      current = false;
      cache = [];
      if (timer !== undefined) clearTimeout(timer);
      if (pending.current === scope) pending.current = null;
    };
  },[api,chatId,enabled,retry]);
  const visible=enabled&&state&&state.api===api&&state.chatId===chatId?state:null;
  return{occurrences:visible?.occurrences??[],failed:visible?.failed??false,incomplete:visible?.incomplete??false,loading:visible?.loading??false,retry:()=>{
    if(pending.current&&pending.current.api===api&&pending.current.chatId===chatId)return;
    setRetry(value=>value+1);
  }};
}
