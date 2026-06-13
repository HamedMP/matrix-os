import { Brain, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

// AI-Elements-style Reasoning: a collapsible "thinking" block. Auto-open while
// streaming, collapsed once done. Lights up only when the kernel emits
// reasoning content (a platform capability that can land later).
export function Reasoning({ streaming, children }: { streaming: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(streaming);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-xs"
        style={{ color: "var(--text-tertiary)" }}
      >
        <Brain size={12} className={streaming ? "status-pulse" : ""} />
        <span>{streaming ? "Thinking…" : "Thought process"}</span>
        <ChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
      </button>
      {open ? (
        <div
          className="mt-1 border-l-2 pl-3 text-sm leading-relaxed"
          style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
          data-selectable
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
