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

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const commands = useCommandStore((s) => s.commands);

  const { apps, actions } = useMemo(() => {
    const apps: Command[] = [];
    const actions: Command[] = [];
    const grouped = { apps, actions };
    for (const cmd of commands.values()) {
      if (cmd.group === "Apps") apps.push(cmd);
      else actions.push(cmd);
    }
    apps.sort((a, b) => a.label.localeCompare(b.label));
    actions.sort((a, b) => a.label.localeCompare(b.label));
    return grouped;
  }, [commands]);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      showCloseButton={false}
      className="top-[20%] translate-y-0 z-[60] max-w-[520px]"
    >
      <CommandInput placeholder="Search commands..." />
      <CommandList>
        <CommandEmpty>No commands found.</CommandEmpty>
        {apps.length > 0 && (
          <CommandGroup heading="Apps">
            {apps.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={[cmd.label, ...(cmd.keywords ?? [])].join(" ")}
                onSelect={() => {
                  cmd.execute();
                  onOpenChange(false);
                }}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut && (
                  <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map((cmd) => (
              <CommandItem
                key={cmd.id}
                value={[cmd.label, ...(cmd.keywords ?? [])].join(" ")}
                onSelect={() => {
                  cmd.execute();
                  onOpenChange(false);
                }}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut && (
                  <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
