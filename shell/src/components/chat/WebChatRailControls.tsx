"use client";
import { useCallback, useRef } from "react";
import { chatSearchShortcutLabel, useChatSearchShortcut } from "@matrix-os/ui";
import { SearchIcon } from "@/lib/hugeicons";
export function WebChatRailControls({query,onQuery,active = true,onSearch}:{query:string;onQuery(value:string):void;active?:boolean;onSearch?:()=>void}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const focusSearch = useCallback(() => {
    onSearch?.();
    searchRef.current?.focus();
  }, [onSearch]);
  useChatSearchShortcut(active, focusSearch);
  return <div className="flex items-center gap-1 px-3 pb-2">
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-background/60 px-2.5 py-1.5 text-xs">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground"/>
      <input ref={searchRef} aria-label="Search chats" aria-keyshortcuts="Meta+K Control+K" placeholder="Search chats..." value={query} onChange={event=>onQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"/>
      <kbd aria-hidden="true" className="shrink-0 text-[12px] font-normal text-muted-foreground" style={{fontFamily:"inherit"}}>{chatSearchShortcutLabel()}</kbd>
    </div>
  </div>;
}
