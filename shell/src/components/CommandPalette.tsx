"use client";

import { useEffect, useRef, useState } from "react";
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

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<"all" | "apps" | "actions" | "settings">("all");
  const [query, setQuery] = useState("");
  const handleInputChange = () => {
    requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: 0 });
    });
  };

  useEffect(() => {
    if (!open) return;
    setCategory("all");
    setQuery("");
    inputRef.current?.focus();
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const { apps, actions, settings } = (() => {
    const apps: Command[] = [];
    const actions: Command[] = [];
    const settings: Command[] = [];
    const grouped = { apps, actions, settings };
    for (const cmd of commands.values()) {
      if (cmd.group === "Apps") apps.push(cmd);
      else if (cmd.id.includes("settings") || cmd.keywords?.some((keyword) => keyword === "settings" || keyword === "preferences")) settings.push(cmd);
      else actions.push(cmd);
    }
    apps.sort((a, b) => a.label.localeCompare(b.label));
    actions.sort((a, b) => a.label.localeCompare(b.label));
    settings.sort((a, b) => a.label.localeCompare(b.label));
    return grouped;
  })();

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      showCloseButton={false}
      className="top-[8%] translate-y-0 z-[60] max-w-[760px] rounded-2xl"
    >
      <div className="relative">
        <CommandInput
          ref={inputRef}
          value={query}
          placeholder="Type a command or search…"
          className="h-16 rounded-none pr-16 text-lg focus-visible:border-transparent focus-visible:ring-0 focus-visible:shadow-none"
          onValueChange={(value: string) => {
            setQuery(value);
            handleInputChange();
          }}
        />
        <kbd className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">⌘K</kbd>
      </div>
      <div role="tablist" aria-label="Command categories" className="flex h-11 items-stretch gap-1 border-b px-4">
        {([
          ["all", "All"],
          ["apps", "Apps"],
          ["actions", "Actions"],
          ["settings", "Settings"],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={category === id}
            className="relative px-3 text-sm font-medium text-muted-foreground aria-selected:text-foreground"
            onClick={() => {
              setCategory(id);
              setQuery("");
              window.requestAnimationFrame(() => inputRef.current?.focus());
            }}
          >
            {label}
            {category === id ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" /> : null}
          </button>
        ))}
      </div>
      <CommandList ref={listRef} className="max-h-[min(560px,68vh)] p-2">
        <CommandEmpty>No commands found.</CommandEmpty>
        {(category === "all" || category === "apps") && apps.length > 0 && (
          <CommandGroup heading="Apps">
            {apps.map((cmd) => (
              <CommandItem
                data-instant-list-hover
                key={cmd.id}
                value={[cmd.label, ...(cmd.keywords ?? [])].join(" ")}
                onSelect={() => {
                  cmd.execute();
                  onOpenChange(false);
                }}
              >
                {cmd.icon ? (
                  // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- app icon served from a runtime gateway host (/icons/{slug}.png) that cannot be statically configured for next/image
                  <img src={cmd.icon} alt="" className="size-7 rounded-lg object-cover shrink-0" />
                ) : (
                  <span className="size-7 rounded-lg bg-muted flex items-center justify-center text-xs font-semibold shrink-0">
                    {cmd.label.charAt(0)}
                  </span>
                )}
                <span>{cmd.label}</span>
                {cmd.shortcut && (
                  <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        {(category === "all" || category === "actions") && actions.length > 0 && (
          <CommandGroup heading="Actions">
            {actions.map((cmd) => (
              <CommandItem
                data-instant-list-hover
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
        {(category === "all" || category === "settings") && settings.length > 0 && (
          <CommandGroup heading="Settings">
            {settings.map((cmd) => (
              <CommandItem
                data-instant-list-hover
                key={cmd.id}
                value={[cmd.label, ...(cmd.keywords ?? [])].join(" ")}
                onSelect={() => {
                  cmd.execute();
                  onOpenChange(false);
                }}
              >
                <span>{cmd.label}</span>
                {cmd.shortcut && <CommandShortcut>{formatShortcut(cmd.shortcut)}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  );
}
