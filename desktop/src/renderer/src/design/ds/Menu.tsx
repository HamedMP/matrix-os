import * as RadixContextMenu from "@radix-ui/react-context-menu";
import * as RadixDropdown from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight } from "lucide-react";
import type { ElementType, ReactElement, ReactNode } from "react";
import { dsCn as cn } from "./cn";
import { DESKTOP_Z_INDEX } from "../layering";
import { Icon } from "./Icon";
import { menuCheck, menuItem, menuItemDestructive, menuItemWithCheck, menuLabel, menuSeparator, menuShortcut, menuSurface } from "./menu-styles";

/**
 * Menus are described as data so a context menu and a dropdown share one
 * renderer and one set of rules: every row in a group has an icon or none
 * does, submenus go one level deep, the destructive row comes last after a
 * separator.
 */
export type MenuEntry =
  | { kind: "item"; id: string; label: string; icon?: ReactNode; shortcut?: string; destructive?: boolean; disabled?: boolean; onSelect: () => void }
  | { kind: "label"; id: string; label: string }
  | { kind: "separator"; id: string }
  | { kind: "submenu"; id: string; label: string; icon?: ReactNode; entries: MenuEntry[] }
  | { kind: "radio"; id: string; value: string; onValueChange: (value: string) => void; options: Array<{ value: string; label: string; icon?: ReactNode }> };

const POPOVER_LAYER = { zIndex: DESKTOP_Z_INDEX.popover };

interface MenuKit {
  Item: ElementType;
  Label: ElementType;
  Separator: ElementType;
  Sub: ElementType;
  SubTrigger: ElementType;
  SubContent: ElementType;
  RadioGroup: ElementType;
  RadioItem: ElementType;
  ItemIndicator: ElementType;
  Portal: ElementType;
}

const DROPDOWN_KIT: MenuKit = RadixDropdown;
const CONTEXT_KIT: MenuKit = RadixContextMenu;

function renderEntries(kit: MenuKit, entries: MenuEntry[], depth: number): ReactNode {
  return entries.map((entry) => {
    switch (entry.kind) {
      case "separator":
        return <kit.Separator key={entry.id} className={menuSeparator} />;
      case "label":
        return <kit.Label key={entry.id} className={menuLabel}>{entry.label}</kit.Label>;
      case "item":
        return (
          <kit.Item key={entry.id} disabled={entry.disabled} onSelect={entry.onSelect} className={cn(menuItem, entry.destructive && menuItemDestructive)}>
            {entry.icon}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.shortcut ? <span className={menuShortcut}>{entry.shortcut}</span> : null}
          </kit.Item>
        );
      case "radio":
        return (
          <kit.RadioGroup key={entry.id} value={entry.value} onValueChange={entry.onValueChange}>
            {entry.options.map((option) => (
              <kit.RadioItem key={option.value} value={option.value} className={cn(menuItem, menuItemWithCheck)}>
                {option.icon}
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                <span className={menuCheck}>
                  <kit.ItemIndicator><Icon icon={Check} size="xs" /></kit.ItemIndicator>
                </span>
              </kit.RadioItem>
            ))}
          </kit.RadioGroup>
        );
      case "submenu":
        if (depth > 0) throw new Error("Menus allow one level of submenu.");
        return (
          <kit.Sub key={entry.id}>
            <kit.SubTrigger className={cn(menuItem, "data-[state=open]:bg-ds-accent")}>
              {entry.icon}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              <Icon icon={ChevronRight} size="xs" className="ml-auto" />
            </kit.SubTrigger>
            <kit.Portal>
              <kit.SubContent sideOffset={4} className={menuSurface} style={POPOVER_LAYER}>{renderEntries(kit, entry.entries, depth + 1)}</kit.SubContent>
            </kit.Portal>
          </kit.Sub>
        );
    }
  });
}

/** Dropdown menu opened from a trigger button; Radix names the menu after its trigger. */
export function DropdownMenu({
  trigger,
  entries,
  align = "end",
  onOpenChange,
}: {
  trigger: ReactElement;
  entries: MenuEntry[];
  align?: "start" | "center" | "end";
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RadixDropdown.Root modal={false} onOpenChange={onOpenChange}>
      <RadixDropdown.Trigger asChild>{trigger}</RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content align={align} sideOffset={6} className={menuSurface} style={POPOVER_LAYER}>
          {renderEntries(DROPDOWN_KIT, entries, 0)}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}

/** Right-click menu around its children. Entries may be computed when it opens. */
export function ContextMenu({
  entries,
  children,
  onOpenChange,
}: {
  entries: MenuEntry[];
  children: ReactElement;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <RadixContextMenu.Root onOpenChange={onOpenChange}>
      <RadixContextMenu.Trigger asChild>{children}</RadixContextMenu.Trigger>
      <RadixContextMenu.Portal>
        {entries.length > 0 ? <RadixContextMenu.Content className={menuSurface} style={POPOVER_LAYER}>{renderEntries(CONTEXT_KIT, entries, 0)}</RadixContextMenu.Content> : null}
      </RadixContextMenu.Portal>
    </RadixContextMenu.Root>
  );
}
