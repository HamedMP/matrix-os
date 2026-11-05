import { useMemo, useLayoutEffect, useRef, useState } from "react";
/** One explicit owner submit; exact request reconciliation retains its original route. */
export function usePersistentTaskSelection({scope,eligible}:{scope:unknown;eligible:boolean}) {
  const identity=useMemo(()=>({scope,eligible}),[scope,eligible]);
  const current=useRef<typeof identity|null>(null), choice=useRef<typeof identity|null>(null);
  useLayoutEffect(()=>{current.current=identity;return()=>{current.current=null;choice.current=null;};},[identity]);
  const retained=useRef<{identity:typeof identity;requestId:string}|null>(null);
  const [chosen,setChosen]=useState<typeof identity|null>(null);
  const selected=eligible&&chosen===identity;
  return {selected,select:(value:boolean)=>{if(current.current===identity&&eligible){choice.current=value?identity:null;setChosen(choice.current);}},consume:(requestId?:string):"matrix"|undefined=>{
    if(current.current!==identity)throw new Error("Chat context changed.");
    if(!eligible)return;
    if(requestId&&retained.current?.identity===identity&&retained.current.requestId===requestId)return "matrix";
    if(choice.current!==identity)return;
    choice.current=null;
    retained.current=requestId?{identity,requestId}:null;
    setChosen(null);return "matrix";
  }};
}
