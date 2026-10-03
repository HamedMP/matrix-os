import { RailCollapse } from "./RailCollapse";
import type { ReactNode } from "react";
import { ChevronRight } from "@renderer/lib/hugeicons";

export function WorkRailSection({
  label,
  expanded,
  onToggle,
  action,
  count,
  children,
}: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  action?: ReactNode;
  count?: number;
  divider?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="mb-1 flex flex-col gap-0.5">
      <div data-slot="chat-sidebar-section-heading" className="flex items-center">
        <button
          type="button"
          aria-label={label}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center rounded-md pl-2.5 pr-0 pb-1 pt-2 text-left text-xs font-semibold uppercase tracking-wide outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onToggle}
        >
          <span>{label}</span>
          <span className="ml-auto mr-2.5 text-[10px] font-normal tabular-nums" aria-hidden>{count || null}</span>
          <span className="grid w-8 shrink-0 place-items-center"><ChevronRight size={12} aria-hidden className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} /></span>
        </button>
        {action}
      </div>
      <RailCollapse expanded={expanded} className="flex flex-col gap-0.5">{children}</RailCollapse>
    </section>
  );
}
