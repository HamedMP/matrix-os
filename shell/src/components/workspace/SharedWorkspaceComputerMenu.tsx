"use client";
import Link from "next/link";
import { DropdownMenu as Menu } from "radix-ui";
import { CheckIcon, ChevronDownIcon, MonitorIcon } from "@/lib/hugeicons";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";

/** Shared data has no installed personal machine identity or inventory request. */
export function SharedWorkspaceComputerMenu() {
  return <Menu.Root><Menu.Trigger asChild>
    <button type="button" aria-label="Change computer, currently Shared workspace" className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-primary">
      <MonitorIcon className="size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">Shared workspace</span><ChevronDownIcon className="size-3 shrink-0" aria-hidden="true" />
    </button>
  </Menu.Trigger><Menu.Portal><Menu.Content aria-label="Computers" align="end" sideOffset={6} collisionPadding={8} className="w-[248px] rounded-xl border border-border bg-card p-1.5 shadow-lg" style={{ zIndex: SHELL_Z_INDEX.popover }}>
    <Menu.Item disabled className="flex items-center gap-2 rounded-md px-2 py-2 text-[13px]"><MonitorIcon className="size-3.5" aria-hidden="true" /><span className="flex-1">Shared workspace</span><CheckIcon className="size-3.5" aria-hidden="true" /></Menu.Item>
    <Link href="/runtime" className="flex rounded-md px-2 py-2 text-[13px] hover:bg-foreground/5">Personal computers</Link>
  </Menu.Content></Menu.Portal></Menu.Root>;
}
