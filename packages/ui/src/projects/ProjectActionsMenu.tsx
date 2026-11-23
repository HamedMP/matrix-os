import * as ContextMenu from "@radix-ui/react-context-menu";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import { Fragment, type ReactNode, type Ref } from "react";

/** One project row action; Electron Desktop and the web OS views list the same entries. */
export interface ProjectMenuAction {
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  danger?: boolean;
  onSelect(): void;
}
const contentClass = "min-w-[200px] rounded-xl border p-1 shadow-xl outline-none";
const contentStyle = (zIndex: number) => ({
  zIndex,
  background: "var(--bg-overlay, var(--popover))",
  color: "var(--text-primary, var(--popover-foreground))",
  borderColor: "var(--border-default, var(--border))",
  boxShadow: "var(--shadow-2)",
});
const itemClass = "flex cursor-default items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[disabled]:opacity-40";
const itemColor = (danger?: boolean) => danger ? "var(--danger-text, var(--destructive))" : "var(--text-primary, var(--foreground))";
const DEFAULT_BUTTON_CLASS = "flex size-7 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]";

export function ProjectActionsMenu({ items, zIndex, children, onOpenChange }: { items: ProjectMenuAction[]; zIndex: number; children: ReactNode; onOpenChange?(open: boolean): void }) {
  return <ContextMenu.Root onOpenChange={onOpenChange}>
    <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
    <ContextMenu.Portal><ContextMenu.Content className={contentClass} style={contentStyle(zIndex)}>
      {items.map(item => <Fragment key={item.label}>
        {item.danger ? <ContextMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle, var(--border))" }} /> : null}
        <ContextMenu.Item disabled={item.disabled} onSelect={item.onSelect} className={itemClass} style={{ color: itemColor(item.danger) }}>{item.icon}{item.label}</ContextMenu.Item>
      </Fragment>)}
    </ContextMenu.Content></ContextMenu.Portal>
  </ContextMenu.Root>;
}

export function ProjectActionsButton({ name, items, zIndex, buttonRef, className = DEFAULT_BUTTON_CLASS, onOpenChange }: {
  name: string; items: ProjectMenuAction[]; zIndex: number; buttonRef?: Ref<HTMLButtonElement>; className?: string; onOpenChange?(open: boolean): void;
}) {
  return <DropdownMenu.Root onOpenChange={onOpenChange}>
    <DropdownMenu.Trigger asChild>
      <button ref={buttonRef} type="button" aria-label={`Actions for ${name}`} title={`Actions for ${name}`} className={className}>
        <MoreHorizontal size={15} aria-hidden />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content align="end" sideOffset={4} className={contentClass} style={contentStyle(zIndex)}>
      {items.map(item => <Fragment key={item.label}>
        {item.danger ? <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle, var(--border))" }} /> : null}
        <DropdownMenu.Item disabled={item.disabled} onSelect={item.onSelect} className={itemClass} style={{ color: itemColor(item.danger) }}>{item.icon}{item.label}</DropdownMenu.Item>
      </Fragment>)}
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
