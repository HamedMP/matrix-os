"use client";
import {applicableCompanyDriveDraft,useCompanyDriveChatDraft} from "@/stores/company-drive-chat-draft";
import { useAuth } from "@clerk/nextjs";
import { getGatewayUrl } from "@/lib/gateway";
import { useEffect } from "react";
import { companyDriveChatReference, OrganizationDrivesNavigation, useChatDriveProjects, type ChatAgentClient, type StartAgentChat } from "@matrix-os/ui";
import { useBrowserOrigin } from "@/hooks/useBrowserOrigin";
import { useWindowManager } from "@/hooks/useWindowManager";
import { useShellCollaborationApi } from "@/lib/collaboration-organization";
import { organizationDriveNavigationIdentity, useOrganizationDriveNavigation } from "@/stores/organization-drive-navigation";
import { useCollaborationOrganization } from "@/lib/collaboration-organization-state";
export function OrganizationDrivesNav({chats=[],client,onNewChat,onSelectChat,activeChatId}: {chats?:readonly {id:string;title?:string;updatedAt?:number}[];client?:ChatAgentClient;onNewChat?:StartAgentChat;onSelectChat?(id:string):void;activeChatId?:string}) {
  const { status: organizationStatus } = useCollaborationOrganization();
  const {userId, sessionId} = useAuth();
  const identity = organizationDriveNavigationIdentity(userId, sessionId, getGatewayUrl());
  const request=useCompanyDriveChatDraft(state=>state.request);
  // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent -- this consumes a one-shot cross-window navigation request and deliberately hands it to the owning Chat controller.
  useEffect(()=>{if(!request||!onNewChat||useCompanyDriveChatDraft.getState().request!==request)return;useCompanyDriveChatDraft.getState().consume(request);if(organizationStatus !== "none"&&applicableCompanyDriveDraft(request,identity))onNewChat("",[request.reference]);},[request,identity,onNewChat,organizationStatus]);
  const origin = useBrowserOrigin();
  const api = useShellCollaborationApi(origin, Boolean(userId) && organizationStatus !== "none", identity);
  const projectState=useChatDriveProjects(client?.driveProjects,chats.map(chat=>({id:chat.id,revision:chat.updatedAt})),organizationStatus !== "none");
  const grouped=projectState.associations.flatMap(association=>{const chat=chats.find(item=>item.id===association.chatId);return association.reference&&chat?[{chatId:chat.id,title:chat.title??"Chat",scopeId:association.reference.scopeId}]:[];});
  if (organizationStatus === "none") return null;
  return <OrganizationDrivesNavigation chatLoading={projectState.loading} chatError={projectState.error} api={api} chats={grouped} activeChatId={activeChatId} onSelectChat={onSelectChat} onNewChat={onNewChat?drive=>onNewChat("",[companyDriveChatReference(drive)]):undefined} onOpen={drive => {
    useOrganizationDriveNavigation.getState().open(drive.scopeId, identity);
    const manager = useWindowManager.getState();
    const existing = manager.windows.find(window => window.path === "__file-browser__");
    if (existing) {manager.restoreWindow(existing.id); manager.focusWindow(existing.id);}
    else manager.openWindow("Files", "__file-browser__", 0);
  }}/>;
}
