import { RailCollapse } from "./RailCollapse";
import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export function WorkRailSection({ label, expanded, onToggle, action, icon, count = 0, attention = false, children }: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
  action?: ReactNode;
  icon?: ReactNode;
  count?: number;
  attention?: boolean;
  divider?: boolean;
  children: ReactNode;
}) {
  return <section className="work-rail-section" data-expanded={expanded}>
    <div data-slot="chat-sidebar-section-heading" className={`work-rail-section-heading ${icon ? "work-rail-group-heading" : ""}`}>
      <button type="button" aria-label={label} aria-expanded={expanded}
        className="work-rail-section-toggle min-w-0 flex-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        onClick={onToggle}>
        {icon ? <span className="work-rail-section-icon" aria-hidden>{icon}</span> : null}
        <span className="truncate">{label}</span>
        <span className="work-rail-section-disclosure" aria-hidden>
          <ChevronRight size={11} className={`transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
        </span>
        {count > 0 && (attention || !expanded) ? <span className={`work-rail-section-count ${attention ? "work-rail-attention-count" : ""}`} aria-label={`${count} ${attention ? "chats need attention" : "hidden items"}`}>{count}</span> : null}
      </button>
      {action}
    </div>
    <RailCollapse expanded={expanded} className="flex flex-col gap-0.5">{children}</RailCollapse>
  </section>;
}
