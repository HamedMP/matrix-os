import { Brain, ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";
import { markerVariants } from "./marker";

// AI-Elements-style Reasoning: a collapsible "thinking" block. Auto-open while
// streaming, collapsed once done. Lights up only when the kernel emits
// reasoning content (a platform capability that can land later). The header is
// a Marker-style row whose label shimmers while the turn streams.
export function Reasoning({ streaming, children }: { streaming: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(streaming);
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={markerVariants({
          className: "self-start rounded-md px-1 py-0.5 text-xs hover:bg-[var(--bg-hover)]",
        })}
      >
        <Brain className={streaming ? "size-3.5 status-pulse" : "size-3.5"} />
        <span className={streaming ? "shimmer" : undefined}>{streaming ? "Thinking…" : "Thought process"}</span>
        <ChevronRight className="size-3.5" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
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
