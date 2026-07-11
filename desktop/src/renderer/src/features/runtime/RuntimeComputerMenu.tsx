import { Check, ChevronUp, LoaderCircle, Monitor, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const loadStatus = useRuntimeComputers((state) => state.status);
  const computers = useRuntimeComputers((state) => state.computers);
  const switchingSlot = useRuntimeComputers((state) => state.switchingSlot);
  const switchError = useRuntimeComputers((state) => state.switchError);
  const refresh = useRuntimeComputers((state) => state.refresh);
  const select = useRuntimeComputers((state) => state.select);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void refresh();
  }, [connectionStatus, handle, platformHost, refresh, runtimeSlot]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnPointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const current = useMemo(
    () => computers.find((computer) => computer.runtimeSlot === runtimeSlot)
      ?? null,
    [computers, runtimeSlot],
  );
  const currentLabel = current?.label ?? fallbackComputerLabel(runtimeSlot);
  const buttonLabel = loadStatus === "error"
    ? "Computer list unavailable"
    : `Change computer, currently ${currentLabel}`;

  return (
    <div ref={rootRef} className="relative px-2 py-1">
      {open ? (
        <div
          role="listbox"
          aria-label="Choose computer"
          className="absolute bottom-full left-2 right-2 mb-1 overflow-hidden rounded-xl border p-1 shadow-lg"
          style={{ zIndex: 20, borderColor: "var(--border-default)", background: "var(--bg-elevated)" }}
        >
          <div className="flex items-center justify-between gap-2 px-2 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: "var(--text-tertiary)" }}>
              Computers
            </span>
            <button
              type="button"
              aria-label="Retry computers"
              disabled={loadStatus === "loading"}
              className="rounded p-1 hover:bg-[var(--bg-hover)] disabled:opacity-40"
              style={{ color: "var(--text-tertiary)" }}
              onClick={() => void refresh({ force: true })}
            >
              <RefreshCw size={12} className={loadStatus === "loading" ? "animate-spin" : ""} aria-hidden="true" />
            </button>
          </div>
          {loadStatus === "error" ? (
            <p className="px-2 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>Computers unavailable</p>
          ) : null}
          {loadStatus === "loading" && computers.length === 0 ? (
            <p className="flex items-center gap-2 px-2 py-3 text-xs" style={{ color: "var(--text-secondary)" }}>
              <LoaderCircle size={13} className="animate-spin" aria-hidden="true" /> Loading computers…
            </p>
          ) : null}
          {computers.map((computer) => {
            const selected = computer.runtimeSlot === runtimeSlot;
            const switching = switchingSlot === computer.runtimeSlot;
            const disabled = selected || computer.availability !== "available" || Boolean(switchingSlot);
            return (
              <button
                key={computer.runtimeSlot}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-60"
                onClick={() => {
                  setOpen(false);
                  void select(computer.runtimeSlot);
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
                {selected ? <Check size={13} className="shrink-0" style={{ color: "var(--accent)" }} aria-hidden="true" /> : null}
              </button>
            );
          })}
          {switchError ? <p className="px-2 py-2 text-[11px]" style={{ color: "var(--danger)" }}>Couldn&apos;t switch computers. Try again.</p> : null}
        </div>
      ) : null}
      <button
        type="button"
        aria-label={buttonLabel}
        title={collapsed ? currentLabel : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-9 w-full items-center rounded-md transition-colors hover:bg-[var(--bg-hover)] ${collapsed ? "justify-center" : "gap-2 px-2"}`}
        style={{ color: "var(--text-secondary)" }}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-md" style={{ background: "var(--bg-hover)" }}>
          <Monitor size={14} aria-hidden="true" />
          <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border" style={{ background: current?.availability === "available" ? "var(--success)" : loadStatus === "error" ? "var(--danger)" : "var(--warning)", borderColor: "var(--bg-sunken)" }} />
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
    </div>
  );
}
