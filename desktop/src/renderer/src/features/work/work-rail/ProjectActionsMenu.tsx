import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "@renderer/lib/hugeicons";
import { Fragment, type ReactNode, type Ref } from "react";
import { DESKTOP_Z_INDEX } from "../../../design/layering";

export interface ProjectMenuAction {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect(): void;
}
const contentClass = "min-w-[200px] rounded-xl border p-1 shadow-xl outline-none";
const contentStyle = { zIndex: DESKTOP_Z_INDEX.popover, background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" };
const itemClass = "flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[disabled]:opacity-40";

export function ProjectActionsMenu({ items, children }: { items: ProjectMenuAction[]; children: ReactNode }) {
  return <ContextMenu.Root>
    <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className={contentClass} style={contentStyle}>
      {items.map(item => <Fragment key={item.label}>
        {item.danger ? <ContextMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} /> : null}
        <ContextMenu.Item disabled={item.disabled} onSelect={item.onSelect} className={itemClass} style={{ color: item.danger ? "var(--danger)" : "var(--text-primary)" }}>{item.icon}{item.label}</ContextMenu.Item>
      </Fragment>)}
    </ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu.Root>;
}

export function ProjectActionsButton({ name, items, buttonRef }: { name: string; items: ProjectMenuAction[]; buttonRef?: Ref<HTMLButtonElement> }) {
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button ref={buttonRef} type="button" aria-label={`Actions for ${name}`} title={`Actions for ${name}`} className="flex size-7 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
        <MoreHorizontal size={15} aria-hidden />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className={contentClass} style={contentStyle}>
      {items.map(item => <Fragment key={item.label}>
        {item.danger ? <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle)" }} /> : null}
        <DropdownMenu.Item disabled={item.disabled} onSelect={item.onSelect} className={itemClass} style={{ color: item.danger ? "var(--danger)" : "var(--text-primary)" }}>{item.icon}{item.label}</DropdownMenu.Item>
      </Fragment>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
