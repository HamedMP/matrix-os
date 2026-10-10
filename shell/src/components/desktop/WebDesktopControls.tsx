"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DropdownMenu as Menu } from "radix-ui";
import { z } from "zod/v4";
import { MatrixComputerListSchema, MatrixComputerRuntimeSlotSchema, type MatrixComputerList } from "@matrix-os/contracts";
import { DesktopActivityInbox, DesktopTopBarActions } from "@matrix-os/ui";
import { CheckIcon, ChevronDownIcon, MonitorIcon, RefreshCwIcon } from "@/lib/hugeicons";
import { getGatewayUrl } from "@/lib/gateway";
import { SHELL_Z_INDEX } from "@/lib/shell-layering";
import { UserButton } from "../UserButton";
import { GettingStartedPopover } from "../onboarding/GettingStartedPopover";

export type WebDesktopSettingsSection = "appearance" | "billing" | "integrations" | "agents-providers" | "organization";
interface WebDesktopControlsProps {
  onOpenSettings: (section: WebDesktopSettingsSection) => void;
  onOpenCommandPalette: () => void;
  onOpenSupport: () => void;
  onOpenFirstWork: () => void;
}

async function loadActivity(): Promise<unknown> {
  const response = await fetch(`${getGatewayUrl()}/api/coding-agents/summary`, { signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Activity unavailable");
  return response.json();
}

/** Shared action ordering and menus, with web-authenticated transports. */
export function WebDesktopControls({ onOpenSettings, onOpenCommandPalette, onOpenSupport, onOpenFirstWork }: WebDesktopControlsProps) {
  const gateway = getGatewayUrl();
  return <DesktopTopBarActions onSearch={onOpenCommandPalette}
    inbox={<DesktopActivityInbox scope={gateway} load={loadActivity} />}
    help={<GettingStartedPopover onOpenSettings={onOpenSettings} onOpenFirstWork={onOpenFirstWork}
      helpMenu={{ onSupport: onOpenSupport, discordIcon: <span aria-hidden="true" className="size-3.5 shrink-0 bg-current" style={{ mask: `url(${gateway}/system-app-icons/v3/discord.svg) center/contain no-repeat` }} /> }} />}
    computer={<WebComputerMenu gateway={gateway} />} account={<UserButton variant="menubar" onOpenSettings={onOpenSettings} />} />;
}

const ComputerContextSchema = z.object({ runtime: z.object({ runtimeSlot: MatrixComputerRuntimeSlotSchema }).passthrough() }).passthrough();
async function loadWebComputers(gateway: string, signal: AbortSignal) {
  async function read(url: string): Promise<unknown> {
    const response = await fetch(url, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("Computer inventory unavailable");
    return response.json();
  }
  const [list, context] = await Promise.all([read("/api/auth/computers"), read(`${gateway}/api/system/info`)]);
  const inventory = MatrixComputerListSchema.parse(list);
  const slot = ComputerContextSchema.parse(context).runtime.runtimeSlot;
  // Installed runtime identity wins over the account's stored primary selection.
  if (!inventory.items.some(computer => computer.runtimeSlot === slot)) throw new Error("Current computer unavailable");
  return { inventory, slot };
}

const rowClass = "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] outline-none data-[highlighted]:bg-foreground/5 data-[disabled]:opacity-50";

function WebComputerMenu({ gateway }: { gateway: string }) {
  return <ScopedComputerMenu key={gateway} gateway={gateway} />;
}

function ScopedComputerMenu({ gateway }: { gateway: string }) {
  const [open, setOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; inventory: MatrixComputerList | null; slot: string | null }>({ status: "loading", inventory: null, slot: null });
  // react-doctor-disable-next-line react-doctor/no-fetch-in-effect -- This client-only computer inventory has bounded validated results, a 10s deadline, explicit abort cleanup and a gateway-keyed remount. Late responses are discarded; switching computers must not share a cached connection context.
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
    void loadWebComputers(gateway, signal).then(({ inventory, slot }) => {
      if (!controller.signal.aborted) setState({ status: "ready", inventory, slot });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.warn("[computer-menu] inventory unavailable:", error instanceof Error ? error.name : typeof error);
        setState({ status: "error", inventory: null, slot: null });
      }
    });
    return () => controller.abort();
  }, [gateway, refresh]);
  const current = state.inventory?.items.find(computer => computer.runtimeSlot === state.slot);
  const label = current?.label ?? (state.status === "loading" ? "Loading computers…" : "Computer unavailable");
  const triggerLabel = state.status === "loading" ? "Loading computers" : state.status === "error" ? "Computer list unavailable" : `Change computer, currently ${label}`;
  const requestRefresh = useCallback(() => { setState({ status: "loading", inventory: null, slot: null }); setRefresh(value => value + 1); }, []);
  return <Menu.Root open={open} onOpenChange={setOpen}><Menu.Trigger asChild>
    <button type="button" aria-label={triggerLabel} className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-[13px] hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-primary">
      <MonitorIcon className="size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{label}</span><ChevronDownIcon className="size-3 shrink-0" aria-hidden="true" />
    </button>
  </Menu.Trigger><Menu.Portal><Menu.Content aria-label="Computers" align="end" sideOffset={6} collisionPadding={8} className="w-[248px] rounded-xl border border-border bg-card p-1.5 shadow-lg" style={{ zIndex: SHELL_Z_INDEX.popover }}>
    <div className="flex items-center justify-between px-2 py-1 text-[11px] text-muted-foreground"><span>COMPUTERS</span><button type="button" aria-label="Refresh computers" onClick={requestRefresh} className="rounded p-1 focus-visible:outline-2 focus-visible:outline-primary"><RefreshCwIcon className="size-3.5" aria-hidden="true" /></button></div>
    {state.status === "loading" ? <p role="status" className="p-2 text-xs">Loading computers…</p> : null}
    {state.status === "error" ? <p role="alert" className="p-2 text-xs">Your computer list is unavailable. Try refreshing.</p> : null}
    {state.inventory?.items.map(computer => {
      const selected = computer.runtimeSlot === state.slot;
      const contents = <><MonitorIcon className="size-3.5 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1"><span className="block truncate">{computer.label}</span><span className="block text-[11px] text-muted-foreground">{selected ? "Current" : computer.availability === "available" ? "Available" : computer.availability === "starting" ? "Starting" : "Unavailable"} · {computer.handle}</span></span>{selected ? <CheckIcon className="size-3.5" aria-hidden="true" /> : null}</>;
      return computer.availability === "available" && !selected
        ? /* react-doctor-disable-next-line react-doctor/nextjs-no-a-element -- Switching computers deliberately reloads the document to discard the previous owner/runtime connection, sockets and state. Next client navigation would retain that context. */
          <Menu.Item key={computer.runtimeSlot} asChild><a href={computer.gatewayPath} className={rowClass}>{contents}</a></Menu.Item>
        : <Menu.Item key={computer.runtimeSlot} disabled className={rowClass}>{contents}</Menu.Item>;
    })}
    {state.inventory?.hasMore ? <Link href="/runtime" className={rowClass}>All computers</Link> : null}
  </Menu.Content></Menu.Portal></Menu.Root>;
}
