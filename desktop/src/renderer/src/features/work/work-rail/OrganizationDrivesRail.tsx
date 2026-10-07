import type {CanonicalChatRecord} from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { companyDriveChatReference, OrganizationDrivesNavigation, useChatDriveProjects, type ChatAgentClient, type StartAgentChat, type CollaborationDirectApi } from "@matrix-os/ui";
import { createDesktopCollaborationApi, releaseDesktopCollaborationApi } from "../../../lib/collaboration";
import { useConnection } from "../../../stores/connection";
import { useFilesNavigation } from "../../../stores/files-navigation";
import { FILES_WORKSPACE_TAB_SPEC, useTabs } from "../../../stores/tabs";
export function OrganizationDrivesRail({active,chats=[],client,onNewChat,onSelectChat,activeChatId}: {active: boolean;chats?:readonly CanonicalChatRecord[];client?:ChatAgentClient;onNewChat?:StartAgentChat;onSelectChat?(record:CanonicalChatRecord):void;activeChatId?:string}) {
  const host=useConnection(state => state.platformHost);
  const slot=useConnection(state => state.runtimeSlot);
  const generation=useConnection(state => state.authGeneration);
  const organizationStatus=useConnection(state => state.organizationStatus);
  const identity = `${host}\0${slot}\0${generation}`;
  const [apiState,setApiState]=useState<{identity: string; api: CollaborationDirectApi | null} | null>(null);
  const api = apiState?.identity === identity ? apiState.api : null;
  useEffect(() => {const next=organizationStatus !== "none" ? createDesktopCollaborationApi(host) : null; setApiState({identity, api: next}); return () => {if (next) releaseDesktopCollaborationApi(next);};},[host,identity,organizationStatus]);
  const projectState=useChatDriveProjects(client?.driveProjects,chats.map(record=>({id:record.chat.id,revision:record.chat.revision})),active&&organizationStatus !== "none");
  const grouped=projectState.associations.flatMap(association=>{const record=chats.find(item=>item.chat.id===association.chatId);return association.reference&&record?[{chatId:record.chat.id,title:record.chat.title,scopeId:association.reference.scopeId}]:[];});
  if (organizationStatus === "none") return null;
  return <OrganizationDrivesNavigation chatLoading={projectState.loading} chatError={projectState.error} api={api} active={active} chats={grouped} activeChatId={activeChatId} onSelectChat={id=>{const record=chats.find(item=>item.chat.id===id);if(record)onSelectChat?.(record);}} onNewChat={onNewChat?drive=>onNewChat("",[companyDriveChatReference(drive)]):undefined} onOpen={drive => {useFilesNavigation.getState().navigateDrive(drive.scopeId); useTabs.getState().openTab(FILES_WORKSPACE_TAB_SPEC);}}/>;
}
