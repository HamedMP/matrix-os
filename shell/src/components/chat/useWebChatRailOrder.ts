"use client";
import { randomUUID } from "@matrix-os/ui/random-uuid";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { moveRailItem, orderRailItems, type RailSortMode } from "@matrix-os/ui";
import type { RenameableConversation } from "./ChatTitleRename";

function legacyUpdatedAt(value: number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "1970-01-01T00:00:00.000Z";
}

/** Web hosts expose a transport client, not a trusted viewer/runtime storage key. */
export function useWebChatRailOrder(items: readonly RenameableConversation[], client: unknown) {
  const [state,setState] = useState(()=>({client,mode:"lastUpdated" as RailSortMode,ids:[] as string[],scopeKey:randomUUID()}));
  let current = state;
  if (state.client !== client) {
    current = {client,mode:"lastUpdated",ids:[],scopeKey:randomUUID()};
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
  const move = (kind:"chat"|"project",source:string,target:string,visibleIds?:readonly string[])=> {
    if (!identity.current.mounted || identity.current.client !== client || identity.current.scopeKey !== scopeKey) return;
    const visible = visibleIds?.slice(0,1000);
    if (visible && (!visible.includes(source) || !visible.includes(target))) return;
    const prior = current.mode === "manual" ? current.ids : chats.map(item=>item.id);
    const ids = [...prior].slice(0,1000);
    // Add newly paged rows around their visible anchors without moving saved rows.
    visible?.forEach((id,index) => {
      if (ids.includes(id)) return;
      if (ids.length >= 1000) {
        const evict = ids.findLastIndex(saved => !visible.includes(saved));
        if (evict < 0) return;
        ids.splice(evict,1);
      }
      const next = visible.slice(index + 1).find(saved => ids.includes(saved));
      const previous = visible.slice(0,index).findLast(saved => ids.includes(saved));
      const at = next !== undefined ? ids.indexOf(next) : previous !== undefined ? ids.indexOf(previous) + 1 : ids.length;
      ids.splice(at,0,id);
    });
    if (kind !== "chat" || source === target || !ids.includes(source) || !ids.includes(target)) return;
    // The first explicit reorder snapshots the visible automatic order.
    const displayed = visible ?? ids;
    const movedDown = displayed.indexOf(source) < displayed.indexOf(target);
    const alreadyOrdered = movedDown ? ids.indexOf(source) > ids.indexOf(target) : ids.indexOf(source) < ids.indexOf(target);
    let reordered = alreadyOrdered ? ids : moveRailItem(ids,source,target);
    if (current.mode !== "manual" && visible) {
      const moved = moveRailItem(visible,source,target);
      const slots = ids.filter(id => visible.includes(id));
      // Snapshot the server group's displayed order into its existing slots.
      // Other groups keep their ranks when manual sorting is first activated.
      reordered = ids.map(id => {
        const slot = slots.indexOf(id);
        return slot < 0 ? id : moved[slot]!;
      });
    }
    setState({...current,mode:"manual",ids:reordered});
  };
  return {chats,manualIds:current.mode === "manual" ? current.ids : undefined,mode:current.mode,setMode,move,scopeKey:current.scopeKey};
}

/** Keep server order for unranked rows and apply the current manual preference to every placement. */
export function orderWebChatRows<T>(rows: readonly T[], ids: readonly string[] | undefined, id: (row: T) => string): T[] {
  if (!ids) return [...rows];
  const ranks = new Map(ids.slice(0, 1000).map((value, index) => [value, index]));
  return rows.map((row, index) => ({ row, index })).sort((a, b) =>
    (ranks.get(id(a.row)) ?? -1) - (ranks.get(id(b.row)) ?? -1) || a.index - b.index,
  ).map(item => item.row);
}
