import { useRef, useState, type Dispatch, type SetStateAction, type RefObject } from "react";
import { mergeChatNavigationRecord, type ChatNavigationRecord } from "@matrix-os/ui";
import type { CanonicalChatRecord } from "@matrix-os/contracts";
import type { Project } from "../../../stores/board";
import type { CanonicalChatClient } from "../../../lib/canonical-chat-client";
import { createProjectForChat, projectMoveAuthorityKey } from "./new-project-chat-move";

type Scope = {client: CanonicalChatClient | null; key: string; generation: number; isCurrent?: () => boolean};
export function useWorkRailMoves({client,projects,routeScopeRef,setRecords,setExpandedProjects,onChatMoved}: {
  client: CanonicalChatClient | null; projects: Project[]; routeScopeRef: RefObject<Scope>;
  setRecords: Dispatch<SetStateAction<ChatNavigationRecord[]>>;
  setExpandedProjects: Dispatch<SetStateAction<Record<string,boolean>>>;
  onChatMoved?: (record: CanonicalChatRecord, project?: Project) => void;
}) {
  const [state,setState] = useState<{client:CanonicalChatClient; movingChatId:string | null; error:string | null; authorityKey:string; scope: Scope} | null>(null);
  const moving = useRef<{ client: CanonicalChatClient; scope: Scope } | null>(null);
  const movingChatId = state?.client === client && state.authorityKey === projectMoveAuthorityKey() && (state.scope.isCurrent?.() ?? true) ? state?.movingChatId ?? null : null;
  const error = state?.client === client && state.authorityKey === projectMoveAuthorityKey() && (state.scope.isCurrent?.() ?? true) ? state?.error ?? null : null;
  const moveChat = async (record: ChatNavigationRecord, project: Project) => {
    if (!client || record.activeRun) return;
    const scope = routeScopeRef.current;
    if (!(scope.isCurrent?.() ?? true) || (moving.current?.client === client && (moving.current.scope.isCurrent?.() ?? true))) return;
    const authorityKey = projectMoveAuthorityKey();
    const isCurrent = () => routeScopeRef.current.client === scope.client
      && authorityKey === projectMoveAuthorityKey() && (scope.isCurrent?.() ?? true);
    const attempt = { client, scope };
    moving.current = attempt;
    setState({client,movingChatId:record.chat.id,error:null,authorityKey,scope});
    try {
      const updated = await client.updateProject(record.chat.id, {baseRevision:record.chat.revision,projectId:project.id ?? project.slug});
      if (!isCurrent()) return;
      setRecords(previous => isCurrent() ? previous.map(item => item.chat.id === updated.chat.id ? mergeChatNavigationRecord(item,updated) : item) : previous);
      setExpandedProjects(previous => isCurrent() ? ({...previous,[project.id ?? project.slug]:true}) : previous);
      if (isCurrent() && routeScopeRef.current.generation === scope.generation) onChatMoved?.(updated,project);
    } catch (failure: unknown) {
      console.warn("[work] Chat move failed:", failure instanceof Error ? failure.name : "UnknownError");
      if (isCurrent()) setState({client,authorityKey,scope,movingChatId:record.chat.id,error:"The Chat could not be moved. Its original project is preserved. Refresh and try again."});
    } finally {
      if (moving.current === attempt) moving.current = null;
      if (isCurrent()) setState(previous => isCurrent() && previous?.scope === scope ? {...previous,movingChatId:null} : previous);
    }
  };
  return {movingChatId,error,moveItems:(record:ChatNavigationRecord) => {
    const scope = routeScopeRef.current;
    return [
    ...projects.map(project => ({label:project.name,disabled:Boolean(record.activeRun) || movingChatId !== null || record.projectId === (project.id ?? project.slug) || record.projectId === project.slug,onSelect:() => {if (scope.isCurrent?.() ?? true) void moveChat(record,project);}})),
    {label:"New project",disabled:Boolean(record.activeRun) || movingChatId !== null,onSelect:() => createProjectForChat(record, scope.isCurrent)},
  ];}};
}
