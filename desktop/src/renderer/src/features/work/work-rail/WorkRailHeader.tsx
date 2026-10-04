import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DESKTOP_Z_INDEX } from "../../../design/layering";
import type { RailSortMode } from "./rail-order";
import { PanelLeftOpenIcon, Plus, Search } from "@renderer/lib/hugeicons";

export function WorkRailHeader({
  onNewChat,
  onCollapse,
  showCollapseControl,
}: {
  onNewChat: () => void;
  onCollapse: () => void;
  showCollapseControl: boolean;
}) {
  return (
    <>
      <div data-slot="chat-sidebar-new-chat" className="mx-2 flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium transition-colors duration-100 outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-secondary)" }}
          onClick={onNewChat}
        >
          <Plus size={15} aria-hidden />
          New chat
        </button>
        {showCollapseControl ? (
          <button
            type="button"
            aria-label="Hide Chat navigation"
            aria-expanded={true}
            aria-controls="work-navigation-pane"
            title="Hide Chat navigation"
            className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
            style={{ color: "var(--text-tertiary)" }}
            onClick={onCollapse}
          >
            <PanelLeftOpenIcon size={15} aria-hidden />
          </button>
        ) : null}
      </div>
    </>
  );
}

export function WorkRailSearchControls({ onSearch, sortMode, onSortChange }: {
  onSearch: () => void;
  sortMode: RailSortMode;
  onSortChange: (value: RailSortMode) => void;
}) {
  return <div className="flex shrink-0 items-center gap-0.5">
    <button type="button" aria-label="Search chats" title="Search chats" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm font-medium outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]" style={{ color: "var(--text-secondary)" }} onClick={onSearch}>
      <Search size={15} aria-hidden />Search
    </button>
    <DropdownMenu.Root><DropdownMenu.Trigger asChild>
      <button type="button" aria-label="Sort chats" title={`Sort: ${sortMode === "manual" ? "Manual order" : "Last updated"}`} className="grid size-7 shrink-0 place-items-center rounded-md outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" style={{color:"var(--text-tertiary)"}}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 3h7M2 7h5M2 11h3M12 3v10m-2-2 2 2 2-2"/></svg>
      </button>
    </DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} aria-label="Chat sort order" className="min-w-[180px] rounded-xl border p-1 shadow-xl outline-none" style={{zIndex:DESKTOP_Z_INDEX.popover,background:"var(--bg-overlay)",borderColor:"var(--border-default)"}}>
      <DropdownMenu.RadioGroup value={sortMode} onValueChange={value=>onSortChange(value === "manual" ? "manual" : "lastUpdated")}>
        {([["lastUpdated","Last updated"],["manual","Manual order"]] as const).map(([value,label])=><DropdownMenu.RadioItem key={value} value={value} className="flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)]"><span className="w-3" aria-hidden="true"><DropdownMenu.ItemIndicator>✓</DropdownMenu.ItemIndicator></span>{label}</DropdownMenu.RadioItem>)}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>
  </div>;
}
