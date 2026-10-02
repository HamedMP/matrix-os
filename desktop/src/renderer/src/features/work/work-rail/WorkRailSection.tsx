import type { ReactNode } from "react";

export function WorkRailSection({
  label,
  expanded,
  onToggle,
  action,
  count,
  divider: _divider = true,
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
          className="min-w-0 flex-1 rounded-sm px-2.5 pt-2 pb-1 text-left text-xs font-semibold tracking-wide uppercase outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onToggle}
        >
          {label}
          {count ? <span aria-hidden className="ml-2 text-[10px] font-normal tabular-nums">{count}</span> : null}
        </button>
        {action}
      </div>
      {expanded ? <div className="flex flex-col gap-0.5">{children}</div> : null}
    </section>
  );
}
