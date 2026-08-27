import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, LoaderCircle, Monitor, RefreshCw } from "@renderer/lib/hugeicons";
import { useEffect, useMemo, useRef, useState } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useRuntimeComputers } from "../../stores/runtime-computers";
import { useUi } from "../../stores/ui";

const STATUS_LABEL = {
  available: "Available",
  starting: "Starting",
  unavailable: "Unavailable",
} as const;

function fallbackComputerLabel(slot: string): string {
  if (slot === "primary") return "Main Computer";
  return `${slot.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ")} Computer`;
}

export default function RuntimeComputerMenu({ collapsed }: { collapsed: boolean }) {
  const connectionStatus = useConnection((state) => state.status);
  const platformHost = useConnection((state) => state.platformHost);
  const handle = useConnection((state) => state.handle);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const loadStatus = useRuntimeComputers((state) => state.status);
  const computers = useRuntimeComputers((state) => state.computers);
  const serverSelectedSlot = useRuntimeComputers((state) => state.runtimeSlot);
  const switchingSlot = useRuntimeComputers((state) => state.switchingSlot);
  const switchError = useRuntimeComputers((state) => state.switchError);
  const refresh = useRuntimeComputers((state) => state.refresh);
  const select = useRuntimeComputers((state) => state.select);
  const acquireRendererOverlay = useUi((state) => state.acquireRendererOverlay);
  const releaseRendererOverlay = useUi((state) => state.releaseRendererOverlay);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The token can be on a different slot than the persisted profile (stale
  // profile write); the inventory response's selectedSlot is authoritative.
  const selectedSlot = serverSelectedSlot ?? runtimeSlot;

  useEffect(() => {
    void refresh();
  }, [authGeneration, connectionStatus, handle, platformHost, refresh, runtimeSlot]);

  useEffect(() => {
    if (!open) return;
    acquireRendererOverlay();
    return releaseRendererOverlay;
  }, [acquireRendererOverlay, open, releaseRendererOverlay]);

  const current = useMemo(
    () => computers.find((computer) => computer.runtimeSlot === selectedSlot)
      ?? null,
    [computers, selectedSlot],
  );
  const currentLabel = current?.label ?? fallbackComputerLabel(selectedSlot);
  const baseVisibleLabel = selectedSlot === "primary" ? "Main computer" : currentLabel;
  const inventoryLoading = loadStatus === "loading" && current === null;
  const visiblyUnavailable = loadStatus === "error" || current?.availability === "unavailable";
  const visiblyStarting = current?.availability === "starting";
  const visibleLabel = visiblyUnavailable
    ? `${baseVisibleLabel} unavailable`
    : visiblyStarting
      ? `${baseVisibleLabel} starting…`
      : inventoryLoading
        ? "Loading computers…"
        : baseVisibleLabel;
  const buttonLabel = loadStatus === "error"
    ? "Computer list unavailable"
    : inventoryLoading
      ? "Loading computers"
      : visiblyStarting
        ? `Change computer, currently ${currentLabel}, starting`
        : current?.availability === "unavailable"
          ? `Change computer, currently ${currentLabel}, unavailable`
          : `Change computer, currently ${currentLabel}`;
  const switchComputer = async (runtimeSlotValue: string) => {
    const computer = computers.find((candidate) => candidate.runtimeSlot === runtimeSlotValue);
    if (!computer || runtimeSlotValue === selectedSlot || computer.availability !== "available" || switchingSlot) return;
    if (await select(runtimeSlotValue)) {
      setOpen(false);
      triggerRef.current?.focus();
    }
  };

  return (
    <div className={collapsed ? undefined : "relative"} style={collapsed ? undefined : { height: "22px" }}>
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={buttonLabel}
            title={collapsed ? currentLabel : undefined}
            className={`flex w-full items-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] ${collapsed ? "justify-center" : "absolute inset-x-0 -top-[3px] gap-2 px-2"}`}
            style={{ height: "var(--sidebar-row-height)", color: "var(--text-secondary)" }}
          >
            <span
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
              style={{ color: visiblyUnavailable ? "var(--danger)" : undefined }}
            >
              {visiblyStarting || inventoryLoading
                ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
                : <Monitor size={14} aria-hidden="true" />}
            </span>
            {!collapsed ? (
              <>
                <span className="min-w-0 flex-1 truncate text-left text-[13px] font-medium" style={{ color: "var(--text-primary)" }}>
                  {visibleLabel}
                  {visibleLabel !== currentLabel ? <span className="sr-only">{currentLabel}</span> : null}
                  <span className="sr-only">{current?.handle ?? handle ?? "Select computer"}</span>
                </span>
                <ChevronDown size={14} className="shrink-0 transition-transform" style={{ transform: open ? "rotate(180deg)" : undefined }} aria-hidden="true" />
              </>
            ) : null}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label="Choose computer"
            aria-labelledby={undefined}
            side="bottom"
            align="start"
            sideOffset={4}
            className="relative overflow-hidden border p-1 outline-none"
            style={{
              zIndex: DESKTOP_Z_INDEX.popover,
              width: "var(--sidebar-menu-width)",
              borderColor: "var(--border-default)",
              background: "var(--bg-overlay)",
              boxShadow: "var(--shadow-2)",
              borderRadius: "12px",
            }}
          >
            <div className="flex items-center px-2 py-1.5 pr-8">
              <span className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--text-tertiary)" }}>
                Computers
              </span>
            </div>
            <DropdownMenu.Separator className="mb-1 h-px" style={{ background: "var(--border-subtle)" }} />
            {loadStatus === "error" ? (
              <p aria-live="polite" className="px-2 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>Computers unavailable</p>
            ) : null}
            {loadStatus === "loading" && computers.length === 0 ? (
              <p aria-live="polite" className="flex items-center gap-2 px-2 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
                <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> Loading computers…
              </p>
            ) : null}
            <DropdownMenu.RadioGroup
              value={selectedSlot}
              className="max-h-72 overflow-y-auto"
            >
              {computers.map((computer) => {
                const selected = computer.runtimeSlot === selectedSlot;
                const switching = switchingSlot === computer.runtimeSlot;
                const disabled = computer.availability !== "available" || Boolean(switchingSlot);
                return (
                  <DropdownMenu.RadioItem
                    key={computer.runtimeSlot}
                    value={computer.runtimeSlot}
                    disabled={disabled}
                    className="flex cursor-default items-center gap-2 px-2 py-2 text-left outline-none data-[disabled]:opacity-60 data-[highlighted]:bg-[var(--bg-hover)]"
                    onSelect={(event) => {
                      event.preventDefault();
                      void switchComputer(computer.runtimeSlot);
                    }}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ background: selected ? "var(--accent-muted)" : "var(--bg-hover)", color: selected ? "var(--accent)" : "var(--text-secondary)" }}>
                      {switching ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <Monitor size={14} aria-hidden="true" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium" style={{ color: "var(--text-primary)" }}>{computer.label}</span>
                      <span className="block truncate text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                        {selected ? "Current" : STATUS_LABEL[computer.availability]} · {computer.handle}
                      </span>
                    </span>
                    <span className="flex w-4 items-center justify-center">
                      <DropdownMenu.ItemIndicator>
                        <Check size={13} className="shrink-0" style={{ color: "var(--accent)" }} aria-hidden="true" />
                      </DropdownMenu.ItemIndicator>
                    </span>
                  </DropdownMenu.RadioItem>
                );
              })}
            </DropdownMenu.RadioGroup>
            <DropdownMenu.Item
              aria-label="Retry computers"
              disabled={loadStatus === "loading"}
              className="absolute right-2 top-1.5 rounded p-1 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--bg-hover)]"
              style={{ color: "var(--text-tertiary)" }}
              onSelect={(event) => {
                event.preventDefault();
                void refresh({ force: true });
              }}
            >
              <RefreshCw size={12} className={loadStatus === "loading" ? "animate-spin" : ""} aria-hidden="true" />
            </DropdownMenu.Item>
            {switchError ? <p aria-live="polite" className="px-2 py-2 text-[11px]" style={{ color: "var(--danger)" }}>Couldn&apos;t switch computers. Try again.</p> : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
