import { useMemo, useState } from "react";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { Project } from "../../../stores/board";
import { useConnection } from "../../../stores/connection";
import { DEFAULT_RAIL_ORDER, moveRailItem, orderRailItems, parseRailOrderPreference, type RailOrderPreference, type RailSortMode } from "./rail-order";

export function useWorkRailOrder(records: readonly CanonicalChatRecord[], projects: readonly Project[]) {
  const userId = useConnection(state=>state.userId);
  const host = useConnection(state=>state.platformHost);
  const slot = useConnection(state=>state.runtimeSlot);
  const generation = useConnection(state=>state.authGeneration);
  const signedIn = useConnection(state=>state.status === "signed-in");
  const scope = signedIn && userId ? `matrix-chat-rail-order:${JSON.stringify([host,userId,slot])}` : null;
  const [stored,setStored] = useState(()=>({scope,preference:readPreference(scope)}));
  // Reset derived presentation synchronously when its owner/Computer changes,
  // so a prior identity's manual order is never painted in the new scope.
  let current = stored;
  if (stored.scope !== scope) {
    current = {scope,preference:readPreference(scope)};
    setStored(current);
  }
  const preference = current.preference;
  const chats = useMemo(()=>orderRailItems(records.map(record=>({id:record.chat.id,updatedAt:record.chat.updatedAt,createdAt:record.chat.createdAt,record})),preference.mode,preference.chatIds).map(item=>item.record),[records,preference]);
  const orderedProjects = useMemo(()=>orderRailItems(projects.map(project=>({id:project.id ?? project.slug,updatedAt:project.updatedAt,project})),preference.mode,preference.projectIds).map(item=>item.project),[projects,preference]);
  const scopeKey = JSON.stringify([scope,generation]);
  const save = (next: RailOrderPreference) => {
    const live = useConnection.getState();
    if (live.userId !== userId || live.platformHost !== host || live.runtimeSlot !== slot || live.authGeneration !== generation || (live.status === "signed-in") !== signedIn) return;
    setStored({scope,preference:next});
    if (!scope) return;
    try { window.localStorage.setItem(scope,JSON.stringify(next)); }
    catch (error: unknown) { console.warn("[work] Rail preference save failed:", error instanceof Error ? error.name : "UnknownError"); }
  };
  const setMode = (mode: RailSortMode) => save({...preference,mode,
    chatIds: preference.chatIds.length ? preference.chatIds : chats.map(record=>record.chat.id).slice(0,1000),
    projectIds: preference.projectIds.length ? preference.projectIds : orderedProjects.map(project=>project.id ?? project.slug).slice(0,1000),
  });
  const move = (kind:"chat"|"project", source:string, target:string) => {
    if (preference.mode !== "manual") return;
    const ids = kind === "chat" ? chats.map(record=>record.chat.id) : orderedProjects.map(project=>project.id ?? project.slug);
    save({...preference,[kind === "chat" ? "chatIds" : "projectIds"]:moveRailItem(ids,source,target)});
  };
  return {chats,projects:orderedProjects,mode:preference.mode,setMode,move,scopeKey};
}

function readPreference(scope: string | null): RailOrderPreference {
  if (!scope) return DEFAULT_RAIL_ORDER;
  try { return parseRailOrderPreference(window.localStorage.getItem(scope)); }
  catch (error: unknown) {
    console.warn("[work] Rail preference unavailable:", error instanceof Error ? error.name : "UnknownError");
    return DEFAULT_RAIL_ORDER;
  }
}
