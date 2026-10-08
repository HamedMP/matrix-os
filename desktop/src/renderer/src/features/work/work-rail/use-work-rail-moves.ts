import { useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import { mergeCanonicalChatRecord } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { Project } from "../../../stores/board";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";
import { createProjectForChat, projectMoveAuthorityKey } from "./new-project-chat-move";

type Scope = {client: CanonicalChatClient | null; key: string; generation: number};
export function useWorkRailMoves({client,projects,routeScopeRef,setRecords,setExpandedProjects,onChatMoved}: {
  client: CanonicalChatClient | null; projects: Project[]; routeScopeRef: RefObject<Scope>;
  setRecords: Dispatch<SetStateAction<CanonicalChatRecord[]>>;
  setExpandedProjects: Dispatch<SetStateAction<Record<string,boolean>>>;
  onChatMoved?: (record: CanonicalChatRecord, project?: Project) => void;
}) {
  const [state,setState] = useState<{client:CanonicalChatClient; movingChatId:string | null; error:string | null; authorityKey:string} | null>(null);
  const moving = useRef<CanonicalChatClient | null>(null);
  const movingChatId = state?.client === client && state.authorityKey === projectMoveAuthorityKey() ? state?.movingChatId ?? null : null;
  const error = state?.client === client && state.authorityKey === projectMoveAuthorityKey() ? state?.error ?? null : null;
  const moveChat = async (record: CanonicalChatRecord, project: Project) => {
    if (!client || moving.current === client || record.activeRun) return;
    const scope = routeScopeRef.current;
    const authorityKey = projectMoveAuthorityKey();
    moving.current = client;
    setState({client,movingChatId:record.chat.id,error:null,authorityKey});
    try {
      const updated = await client.updateProject(record.chat.id, {baseRevision:record.chat.revision,projectId:project.id ?? project.slug});
      if (routeScopeRef.current.client !== scope.client || authorityKey !== projectMoveAuthorityKey()) return;
      setRecords(previous => previous.map(item => item.chat.id === updated.chat.id ? mergeCanonicalChatRecord(item,updated) : item));
      setExpandedProjects(previous => ({...previous,[project.id ?? project.slug]:true}));
      if (routeScopeRef.current.generation === scope.generation) onChatMoved?.(updated,project);
    } catch (failure: unknown) {
      console.warn("[work] Chat move failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (routeScopeRef.current.client === scope.client && authorityKey === projectMoveAuthorityKey()) setState({client,authorityKey,movingChatId:record.chat.id,error:"The Chat could not be moved. Its original project is preserved. Refresh and try again."});
    } finally {
      if (moving.current === client) moving.current = null;
      if (routeScopeRef.current.client === scope.client) setState(previous => previous?.client === client ? {...previous,movingChatId:null} : previous);
    }
  };
  return {movingChatId,error,moveItems:(record:CanonicalChatRecord) => [
    ...projects.map(project => ({label:project.name,disabled:Boolean(record.activeRun) || movingChatId !== null || record.projectId === (project.id ?? project.slug) || record.projectId === project.slug,onSelect:() => {void moveChat(record,project);}})),
    {label:"New project",disabled:Boolean(record.activeRun) || movingChatId !== null,onSelect:() => createProjectForChat(record)},
  ]};
}
