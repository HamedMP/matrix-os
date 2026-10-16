import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import type { BotCreationSnapshot, BotDraftProposal, CanonicalProviderCatalog } from "@matrix-os/contracts";
import { createCreationConversation, creationConversationSelection,
  type CreationConversationClient, type CreationConversationState } from "./creation-conversation.js";

/** Host composers and transcripts share the same genuine conversation orchestration. */
export function useCreationConversation(options: {
  client: CreationConversationClient | null;
  snapshot: BotCreationSnapshot;
  catalog: CanonicalProviderCatalog | null;
  isCurrent(): boolean;
  onProposal(proposal: BotDraftProposal): boolean;
}) {
  const [draftText,setDraftText] = useState<{conversation:ReturnType<typeof createCreationConversation>|null;text:string}|null>(null);
  const [observed,setObserved] = useState<{conversation:ReturnType<typeof createCreationConversation>;state:CreationConversationState}|null>(null);
  const sessionId = options.snapshot.sessionId;
  const client = options.client;
  const session = useMemo(() => {
    if (!client) return null;
    let currentOptions: typeof options | null = null;
    const instance: ReturnType<typeof createCreationConversation> = createCreationConversation({
      client,sessionId,
      isCurrent:()=>Boolean(currentOptions?.client===client && currentOptions.snapshot.sessionId===sessionId && currentOptions.isCurrent()),
      onProposal:proposal=>currentOptions?.onProposal(proposal) ?? false,
      onChange:state=>setObserved({conversation:instance,state}),
    });
    return {conversation:instance,update:(next:typeof options)=>{currentOptions=next;},options:()=>currentOptions};
  },[client,sessionId]);
  const conversation = session?.conversation ?? null;
  const state = observed?.conversation === conversation ? observed.state : {detail:null,busy:false,error:"",activeRunId:null};
  useLayoutEffect(() => {session?.update(options);},[session,options]);
  useLayoutEffect(() => {
    conversation?.activate();
    return ()=>conversation?.dispose();
  },[conversation]);
  useEffect(() => {
    if (!conversation || !state.busy || !state.activeRunId) return;
    void conversation.refresh();
    const timer = setInterval(()=>{void conversation.refresh();},1000);
    return ()=>clearInterval(timer);
  },[conversation,state.busy,state.activeRunId]);
  const selection = creationConversationSelection(options.catalog);
  return {
    ...state,text:draftText?.conversation===conversation ? draftText?.text ?? "" : "",
    setText:(value:string)=>{if (conversation?.isCurrent()) setDraftText({conversation,text:value});},
    available:Boolean(conversation && selection),
    send:async (value:string) => {
      const currentOptions=session?.options();
      const currentSelection=creationConversationSelection(currentOptions?.catalog ?? null);
      return conversation && currentOptions && currentSelection ? conversation.send(value,currentOptions.snapshot,currentSelection) : false;
    },
    abort:async ()=>{await conversation?.abort();},
    refresh:async ()=>{await conversation?.refresh();},
  };
}
