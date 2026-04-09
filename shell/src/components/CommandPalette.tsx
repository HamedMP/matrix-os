"use client";

import { useMemo } from "react";
import { useCommandStore, type Command } from "@/stores/commands";
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from "@/components/ui/command";

function formatShortcut(shortcut: string): string {
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
  return shortcut
    .replace(/Cmd/gi, isMac ? "\u2318" : "Ctrl")
    .replace(/Shift/gi, isMac ? "\u21E7" : "Shift")
    .replace(/Alt/gi, isMac ? "\u2325" : "Alt");
}

const GROUP_ORDER = ["Apps", "Actions", "File", "Edit", "View"] as const;

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const commands = useCommandStore((s) => s.commands);

  const groups = useMemo(() => {
    const grouped = new Map<string, Command[]>();
    for (const cmd of commands.values()) {
      const list = grouped.get(cmd.group) ?? [];
      list.push(cmd);
      grouped.set(cmd.group, list);
    }
    // Sort each group alphabetically
    for (const list of grouped.values()) {
      list.sort((a, b) => a.label.localeCompare(b.label));
    }
    // Return in defined order
    return GROUP_ORDER
      .filter((g) => grouped.has(g))
      .map((g) => ({ name: g, commands: grouped.get(g)! }));
  }, [commands]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      showCloseButton={false}
      className="top-[20%] translate-y-0 z-[60] max-w-[520px]"
    >
      <CommandInput placeholder="Search commands, apps..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((group) => (
          <CommandGroup key={group.name} heading={group.name}>
            {group.commands.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={[cmd.label, ...(cmd.keywords ?? [])].join(" ")}
                onSelect={() => {
                  cmd.execute();
                  onOpenChange(false);
                }}
              >
                {cmd.icon ? (
                  <img src={cmd.icon} alt="" className="size-7 rounded-lg object-cover shrink-0" />
                ) : group.name === "Apps" ? (
                  <span className="size-7 rounded-lg bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
                    {cmd.label.charAt(0)}
                  </span>
                ) : null}
                <span>{cmd.label}</span>
                {cmd.shortcut && (
                  <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
