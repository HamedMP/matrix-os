"use client";
import { chatSearchShortcutLabel, useChatSearchShortcut, ChatSourceFilterMenu, type ChatImportSourceFilterValue } from "@matrix-os/ui";
import { SearchIcon } from "@/lib/hugeicons";
export function WebChatRailControls({active = true,onSearch,sourceFilter="all",onSourceFilter}:{active?:boolean;onSearch():void;sourceFilter?:ChatImportSourceFilterValue;onSourceFilter?(value:ChatImportSourceFilterValue):void}) {
  useChatSearchShortcut(active,onSearch);
  return <div className="chat-search-rail-row relative mx-3 mb-2 flex h-8 shrink-0 items-center">
    <button type="button" className="matrix-web-chat-search flex h-8 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 text-sm hover:bg-accent" aria-label="Search chats" aria-keyshortcuts="Meta+K Control+K" onClick={onSearch}><SearchIcon className="size-4 shrink-0"/><span className="flex-1 text-left">Search</span><kbd aria-hidden className="text-xs font-normal text-muted-foreground" style={{fontFamily:"inherit"}}>{chatSearchShortcutLabel()}</kbd></button>
    {onSourceFilter?<ChatSourceFilterMenu value={sourceFilter} onChange={onSourceFilter}/>:null}
  </div>;
}
