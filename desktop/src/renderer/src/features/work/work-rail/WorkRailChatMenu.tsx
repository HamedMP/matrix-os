import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Fragment } from "react";
import { DESKTOP_Z_INDEX } from "../../../design/layering";

export type RailChatAction = { label: string; disabled?: boolean; danger?: boolean; onSelect?: () => void; children?: RailChatAction[] };
const itemClass = "flex cursor-default items-center gap-3 rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[disabled]:opacity-40";
const contentClass = "min-w-[180px] rounded-xl border p-1 shadow-lg outline-none";
const contentStyle = { zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", color: "var(--text-primary)", borderColor: "var(--border-default)" };
function Actions({ items }: { items: RailChatAction[] }) {
  return items.map(item => <Fragment key={item.label}>
    {item.danger ? <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} /> : null}
    {item.children ? <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger disabled={item.disabled} className={itemClass}><span>{item.label}</span><span aria-hidden className="ml-auto">›</span></DropdownMenu.SubTrigger>
      <DropdownMenu.Portal><DropdownMenu.SubContent className={contentClass} style={contentStyle}><Actions items={item.children} /></DropdownMenu.SubContent></DropdownMenu.Portal>
    </DropdownMenu.Sub> : <DropdownMenu.Item disabled={item.disabled} onSelect={item.onSelect} className={itemClass} style={{ color: item.danger ? "var(--danger)" : undefined }}>{item.label}</DropdownMenu.Item>}
  </Fragment>);
}
export function WorkRailChatMenu({ title, items, open, onOpenChange }: { title: string; items: RailChatAction[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  return <DropdownMenu.Root open={open} onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger asChild><button type="button" aria-label={`Actions for ${title}`} title={`Actions for ${title}`} className="flex size-6 shrink-0 items-center justify-center rounded-[8px] outline-none hover:bg-[var(--matrix-chat-rail-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><MoreHorizontal size={15} aria-hidden /></button></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className={contentClass} style={contentStyle}><Actions items={items} /></DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
