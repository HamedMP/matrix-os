import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { ContextMenu, IconButton, type MenuItem } from "../../design/primitives";

export function FileActionMenu({
  label,
  items,
  onMenuOpen,
  children,
  selected = false,
  disabled = false,
}: {
  label: string;
  items: MenuItem[];
  onMenuOpen: () => void;
  children: ReactNode;
  selected?: boolean;
  disabled?: boolean;
}) {
  const content = (
    <div className="group relative" onContextMenu={disabled ? undefined : onMenuOpen}>
        {children}
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <IconButton
              label={`More actions for ${label}`}
              disabled={disabled}
              className={`absolute top-1 right-1 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 ${
                selected ? "opacity-100" : "opacity-0"
              }`}
              onPointerDown={onMenuOpen}
            >
              <MoreHorizontal size={14} aria-hidden />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="fade-in z-[100] min-w-[180px] rounded-lg border p-1"
              style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)", boxShadow: "var(--shadow-2)" }}
            >
              {items.map((item) => (
                <DropdownMenu.Item
                  key={item.label}
                  disabled={item.disabled}
                  onSelect={item.onSelect}
                  className="flex cursor-default items-center rounded-md px-2.5 py-1.5 text-sm outline-none data-[highlighted]:bg-[var(--bg-hover)] data-[disabled]:opacity-40"
                  style={{ color: item.danger ? "var(--danger)" : "var(--text-primary)" }}
                >
                  {item.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
    </div>
  );
  return disabled ? content : <ContextMenu items={items}>{content}</ContextMenu>;
}

export function ManagedFileActionMenu({
  label, selected, disabled, selectedCount, canRename, canMove, canTrash,
  onMenuOpen, onOpen, onOpenInEditor, onRename, onMove, onTrash, children,
}: {
  label: string;
  selected: boolean;
  disabled: boolean;
  selectedCount: number;
  canRename: boolean;
  canMove: boolean;
  canTrash: boolean;
  onMenuOpen: () => void;
  onOpen: () => void;
  onOpenInEditor?: () => void;
  onRename: () => void;
  onMove: () => void;
  onTrash: () => void;
  children: ReactNode;
}) {
  const items: MenuItem[] = [
    { label: "Open", onSelect: onOpen },
    ...(onOpenInEditor ? [{ label: "Open in Editor", onSelect: onOpenInEditor }] : []),
    { label: "Rename", disabled: selectedCount > 1 || disabled || !canRename, onSelect: onRename },
    { label: "Move to…", disabled: !canMove, onSelect: onMove },
    { label: "Move to Trash", danger: true, disabled: !canTrash, onSelect: onTrash },
  ];
  return (
    <FileActionMenu label={label} items={items} selected={selected} disabled={disabled} onMenuOpen={onMenuOpen}>
      {children}
    </FileActionMenu>
  );
}

export function FileCreationContextMenu({
  onNewFile,
  onNewFolder,
  children,
}: {
  onNewFile: () => void;
  onNewFolder: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu items={[
      { label: "New File", onSelect: onNewFile },
      { label: "New Folder", onSelect: onNewFolder },
    ]}>
      {children}
    </ContextMenu>
  );
}
