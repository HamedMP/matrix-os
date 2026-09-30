"use client";
import { useEffect, useState } from "react";
import type { CollaborationDirectApi } from "../collaboration/direct-api.js";
import { subscribeCollaborationDiscoveryChanged } from "../collaboration/discovery-events.js";
import { loadOrganizationDriveOptions, type OrganizationDriveOption } from "./discovery.js";
export type DriveProjectChat = {chatId:string;scopeId:string;title:string};
export function OrganizationDrivesNavigation({api, onOpen, active = true, chats = [], onNewChat, onSelectChat, activeChatId, chatLoading=false,chatError=false}: {
  api: CollaborationDirectApi | null; active?: boolean; onOpen(drive: OrganizationDriveOption): void;
  chatLoading?:boolean;chatError?:boolean;chats?: readonly DriveProjectChat[]; onNewChat?(drive:OrganizationDriveOption):void; onSelectChat?(chatId:string):void; activeChatId?:string;
}) {
  const [snapshot, setSnapshot] = useState<{api: CollaborationDirectApi; drives: OrganizationDriveOption[]} | null>(null);
  const [error, setError] = useState(false);
  const [expanded,setExpanded]=useState<string[]>([]);
  useEffect(() => {
    let current = true; let inFlight = false;
    setSnapshot(null); setError(false); setExpanded([]);
    if (!api || !active) return;
    const load = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const drives = await loadOrganizationDriveOptions(api, {});
        if (current) {setSnapshot({api, drives}); setError(false);}
      } catch (cause: unknown) {
        console.warn("[organization-drive] navigation unavailable", cause instanceof Error ? cause.name : "UnknownError");
        if (current) {setSnapshot(null); setError(true);}
      } finally {inFlight = false;}
    };
    void load();
    const unsubscribe = subscribeCollaborationDiscoveryChanged(() => void load());
    const timer = setInterval(() => void load(), 30_000);
    return () => {current = false; unsubscribe(); clearInterval(timer);};
  }, [api, active]);
  const drives = snapshot?.api === api && active ? snapshot.drives : [];
  if (!api || !active || (!drives.length && !error)) return null;
  return <nav aria-label="Organization drive projects" className="mx-2 mb-2 space-y-1 text-sm">
    <h2 className="px-2 py-1 text-xs font-medium" style={{color: "var(--text-secondary,var(--muted-foreground))"}}>Company drives</h2>
    {error ? <p role="status" className="px-2 text-xs">Drives are unavailable. They will refresh automatically.</p> : null}
    {drives.map(drive => <div key={drive.scopeId}>
      <div className="flex min-w-0 items-center">
        {onNewChat || onSelectChat ? <button type="button" aria-label={`${expanded.includes(drive.scopeId)?"Collapse":"Expand"} ${drive.name} Chats`} aria-expanded={expanded.includes(drive.scopeId)} className="min-h-9 shrink-0 rounded px-2" onClick={()=>setExpanded(current=>current.includes(drive.scopeId)?current.filter(id=>id!==drive.scopeId):[...current.filter(id=>drives.some(item=>item.scopeId===id)),drive.scopeId])}>{expanded.includes(drive.scopeId)?"▾":"▸"}</button>:null}
        <button type="button" aria-label={`Open ${drive.name} drive`} onClick={() => onOpen(drive)} className="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left hover:bg-[var(--bg-hover,var(--muted))] focus-visible:outline-2 focus-visible:outline-[var(--accent)]">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" className="shrink-0"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z"/><path d="M15 12v5m-2.5-2.5h5"/></svg>
          <span className="min-w-0 flex-1 truncate">{drive.name}</span>
          {drive.state === "pending" ? <span className="text-xs">Join</span> : null}
        </button>
      </div>
      {expanded.includes(drive.scopeId)?<div className="ml-4 border-l pl-2" style={{borderColor:"var(--border-default,var(--border))"}}>
        <button type="button" className="min-h-9 w-full rounded px-2 text-left text-xs hover:bg-[var(--bg-hover,var(--muted))]" onClick={()=>onOpen(drive)}>Browse files</button>
        {onNewChat?<button type="button" aria-label={`New Chat with ${drive.name} drive`} disabled={drive.state!=="ready"} className="min-h-9 w-full rounded px-2 text-left text-xs hover:bg-[var(--bg-hover,var(--muted))] disabled:opacity-50" onClick={()=>onNewChat(drive)}>New Chat</button>:null}
        {chats.filter(chat=>chat.scopeId===drive.scopeId).map(chat=><button key={chat.chatId} type="button" aria-current={activeChatId===chat.chatId?"page":undefined} className="min-h-9 w-full truncate rounded px-2 text-left text-xs hover:bg-[var(--bg-hover,var(--muted))]" title={chat.title} onClick={()=>onSelectChat?.(chat.chatId)}>{chat.title}</button>)}
        {!chats.some(chat=>chat.scopeId===drive.scopeId)?<p className="px-2 py-2 text-xs" style={{color:"var(--text-secondary,var(--muted-foreground))"}}>{chatError?"Chats could not be loaded. They will refresh after the next Chat update.":chatLoading?"Loading Chats…":"No loaded Chats for this drive."}</p>:null}
        <p className="px-2 py-2 text-[10px]" style={{color:"var(--text-secondary,var(--muted-foreground))"}}>Only you can read these Chats.</p>
      </div>:null}
    </div>)}
  </nav>;
}
