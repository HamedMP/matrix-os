"use client";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { RailSortMode } from "@matrix-os/ui";
import { SearchIcon } from "@/lib/hugeicons";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
export function WebChatRailControls({query,onQuery,mode,onSort}:{query:string;onQuery(value:string):void;mode:RailSortMode;onSort(value:RailSortMode):void}) {
  return <div className="flex items-center gap-1 px-3 pb-2">
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-background/60 px-2.5 py-1.5 text-xs">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground"/>
      <input aria-label="Search chats" placeholder="Search chats..." value={query} onChange={event=>onQuery(event.target.value)} className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60"/>
    </div>
    <DropdownMenu.Root><DropdownMenu.Trigger asChild><button type="button" aria-label="Sort chats" title={`Sort: ${mode === "manual" ? "Manual order" : "Last updated"}`} className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h7M2 7h5M2 11h3M12 3v10m-2-2 2 2 2-2"/></svg>
    </button></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} aria-label="Chat sort order" className="min-w-[180px] rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl outline-none" style={{zIndex:SHELL_Z_INDEX.popover}}>
      <DropdownMenu.RadioGroup value={mode} onValueChange={value=>onSort(value === "manual" ? "manual" : "lastUpdated")}>
        {([["lastUpdated","Last updated"],["manual","Manual order"]] as const).map(([value,label])=><DropdownMenu.RadioItem key={value} value={value} className="flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-accent"><span className="w-3" aria-hidden="true"><DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator></span>{label}</DropdownMenu.RadioItem>)}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
  </div>;
}
