"use client";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { moveRailItem, orderRailItems, type RailSortMode } from "@matrix-os/ui";
import type { RenameableConversation } from "./ChatTitleRename";

function legacyUpdatedAt(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "1970-01-01T00:00:00.000Z";
}

/** Web hosts expose a transport client, not a trusted viewer/runtime storage key. */
export function useWebChatRailOrder(items: readonly RenameableConversation[], client: unknown) {
  const [state,setState] = useState(()=>({client,mode:"lastUpdated" as RailSortMode,ids:[] as string[],scopeKey:crypto.randomUUID()}));
  let current = state;
  if (state.client !== client) {
    current = {client,mode:"lastUpdated",ids:[],scopeKey:crypto.randomUUID()};
    setState(current);
  }
  const scopeKey = current.scopeKey;
  const identity = useRef({client,scopeKey,mounted:true});
  useLayoutEffect(()=> {
    const owner = {client,scopeKey,mounted:true};
    identity.current = owner;
    return ()=> {owner.mounted=false;};
  },[client,scopeKey]);
  const chats = useMemo(()=>orderRailItems(items.map(item=>({id:item.id,
    updatedAt:item.canonicalRecord?.chat.updatedAt ?? legacyUpdatedAt(item.updatedAt),
    createdAt:item.canonicalRecord?.chat.createdAt,item})),current.mode,current.ids).map(entry=>entry.item),[items,current.mode,current.ids]);
  const setMode = (mode:RailSortMode)=> {
    if (!identity.current.mounted || identity.current.client !== client || identity.current.scopeKey !== scopeKey) return;
    setState({...current,mode,ids:current.ids.length ? current.ids : chats.map(item=>item.id).slice(0,1000)});
  };
  const move = (_kind:"chat"|"project",source:string,target:string)=> {
    if (!identity.current.mounted || identity.current.client !== client || identity.current.scopeKey !== scopeKey || current.mode !== "manual") return;
    setState({...current,ids:moveRailItem(chats.map(item=>item.id),source,target)});
  };
  return {chats,mode:current.mode,setMode,move,scopeKey:current.scopeKey};
}
