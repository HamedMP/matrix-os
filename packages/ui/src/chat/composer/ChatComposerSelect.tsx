import { ChevronDown } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";

export interface ChatComposerSelectOption {
  value: string;
  label: string;
}

/** Compact composer-toolbar picker (effort, permission mode) shared by Web and Electron Desktop Chat. */
export function ChatComposerSelect({
  openRequest = 0,
  label,
  value,
  options,
  menuSide,
  menuZIndex,
  onChange,
}: {
  openRequest?: number;
  label: string;
  value: string;
  options: ChatComposerSelectOption[];
  menuSide: "top" | "bottom";
  menuZIndex?: number;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (openRequest > 0 && trigger.current?.getClientRects().length) setOpen(true); }, [openRequest]);
  if (options.length <= 1) return null;
  const selected = options.find((option) => option.value === value) ?? options[0]!;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          ref={trigger}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex h-8 max-w-[9rem] items-center gap-1.5 truncate rounded-lg px-2 text-sm outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--composer-focus,var(--accent))]"
          style={{ color: "var(--text-secondary)" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setOpen(false);
          }}
        >
          <span className="truncate">{selected.label}</span>
          <HugeiconsIcon icon={ChevronDown} size={12} strokeWidth={1.5} aria-hidden className="shrink-0" style={{ color: "var(--text-tertiary)" }} />
        </button>
      </Popover.Trigger>
      {open ? (
        <Popover.Portal>
          <Popover.Content
            role="menu"
            aria-label={`${label} options`}
            side={menuSide}
            align="end"
            sideOffset={8}
            collisionPadding={16}
            data-preferred-side={menuSide}
            className="z-50 min-w-48 rounded-xl border p-1.5 shadow-xl"
            style={{ borderColor: "var(--border-default)", background: "var(--bg-overlay)", ...(menuZIndex === undefined ? {} : { zIndex: menuZIndex }) }}
          >
            <span className="block px-2 py-1 text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
              {label}
            </span>
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={option.value === selected.value}
                className="flex min-h-9 w-full items-center rounded-lg px-2 text-left text-sm hover:bg-[var(--bg-hover)] aria-checked:bg-[var(--composer-idle-bg,var(--bg-active))]"
                style={{ color: "var(--text-primary)" }}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            ))}
          </Popover.Content>
        </Popover.Portal>
      ) : null}
    </Popover.Root>
  );
}
