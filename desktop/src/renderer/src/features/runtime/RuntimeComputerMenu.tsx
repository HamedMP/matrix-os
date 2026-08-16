import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronUp, LoaderCircle, Monitor, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useRuntimeComputers } from "../../stores/runtime-computers";

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
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The token can be on a different slot than the persisted profile (stale
  // profile write); the inventory response's selectedSlot is authoritative.
  const selectedSlot = serverSelectedSlot ?? runtimeSlot;

  useEffect(() => {
    void refresh();
  }, [authGeneration, connectionStatus, handle, platformHost, refresh, runtimeSlot]);

  const current = useMemo(
    () => computers.find((computer) => computer.runtimeSlot === selectedSlot)
      ?? null,
    [computers, selectedSlot],
  );
  const currentLabel = current?.label ?? fallbackComputerLabel(selectedSlot);
  const buttonLabel = loadStatus === "error"
    ? "Computer list unavailable"
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
    <div className="px-2 py-1">
      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            aria-label={buttonLabel}
            title={collapsed ? currentLabel : undefined}
            className={`flex w-full items-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] ${collapsed ? "justify-center" : "gap-2 px-2"}`}
            style={{ height: "var(--sidebar-row-height)", color: "var(--text-secondary)" }}
          >
            <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--bg-hover)" }}>
              <Monitor size={14} aria-hidden="true" />
              <span
                aria-hidden="true"
                className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border"
                style={{
                  background: current?.availability === "available"
                    ? "var(--success)"
                    : loadStatus === "error"
                      ? "var(--danger)"
                      : "var(--warning)",
                  borderColor: "var(--bg-sunken)",
                }}
              />
            </span>
            {!collapsed ? (
              <>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-xs font-medium" style={{ color: "var(--text-primary)" }}>{currentLabel}</span>
                  <span className="block truncate text-[10px]" style={{ color: "var(--text-tertiary)" }}>{current?.handle ?? handle ?? "Select computer"}</span>
                </span>
                <ChevronUp size={13} className="shrink-0 transition-transform" style={{ transform: open ? "rotate(180deg)" : undefined }} aria-hidden="true" />
              </>
            ) : null}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            aria-label="Choose computer"
            aria-labelledby={undefined}
            side="top"
            align="start"
            sideOffset={4}
            className="relative overflow-hidden rounded-xl border p-1 outline-none"
            style={{
              zIndex: DESKTOP_Z_INDEX.popover,
              width: "var(--sidebar-menu-width)",
              borderColor: "var(--border-default)",
              background: "var(--bg-overlay)",
              boxShadow: "var(--shadow-2)",
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
                    className="flex cursor-default items-center gap-2 rounded-lg px-2 py-2 text-left outline-none data-[disabled]:opacity-60 data-[highlighted]:bg-[var(--bg-hover)]"
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
