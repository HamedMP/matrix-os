import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

/** Shared lifecycle heading: quiet disclosure, live count and accessible toggle. */
export function ChatRailSection({label, count, expanded, onExpandedChange, attention = false, countLabel, children}: {
  countLabel?: string; label: string; count: number; expanded: boolean; onExpandedChange(value: boolean): void; attention?: boolean; children: ReactNode;
}) {
  return <section data-expanded={expanded} aria-label={label} className="matrix-chat-rail-section">
    <div className="matrix-chat-rail-section-header">
    <button type="button" aria-label={label} aria-expanded={expanded} className="matrix-chat-rail-section-heading" onClick={()=>onExpandedChange(!expanded)}>
      <span>{label}</span><ChevronRight aria-hidden="true" size={11} strokeWidth={1.5} className="matrix-chat-rail-section-chevron" style={{transform: expanded ? 'rotate(90deg)' : undefined}}/>
      {count > 0 && (attention || !expanded) ? <span className="matrix-chat-rail-section-count" data-attention={attention} aria-label={countLabel ?? (attention ? `${count} chats need you` : `${count} hidden ${count === 1 ? 'chat' : 'chats'}`)}>{count}</span> : null}
    </button>
    </div>
    <div className="matrix-chat-rail-section-body" aria-hidden={!expanded} inert={!expanded} hidden={!expanded}>{children}</div>
  </section>;
}
