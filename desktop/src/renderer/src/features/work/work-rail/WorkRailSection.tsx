import type { ReactNode } from "react";
import { ChevronRight, Folder } from "@renderer/lib/hugeicons";

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
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 text-left outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${label === "Projects" ? "min-h-9 text-sm font-medium" : "pb-1 pt-2 text-xs font-semibold uppercase tracking-wide"}`}
          style={{ color: "var(--text-tertiary)" }}
          onClick={onToggle}
        >
          {label === "Projects" ? <Folder size={14} aria-hidden /> : null}
          <span>{label}</span>
          <span className="ml-auto text-[10px] font-normal tabular-nums" aria-hidden>{count || null}</span>
          <ChevronRight size={12} aria-hidden className={expanded ? "rotate-90" : undefined} />
        </button>
        {action}
      </div>
      {expanded ? <div className="flex flex-col gap-0.5">{children}</div> : null}
    </section>
  );
}
