import { ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";

// AI-Elements-style Tool: a collapsible card for a tool invocation.
export function Tool({ name, detail }: { name: string; detail?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm"
        style={{ color: "var(--text-secondary)" }}
      >
        <Wrench size={12} style={{ color: "var(--text-tertiary)" }} />
        <span className="min-w-0 flex-1 truncate font-medium" style={{ color: "var(--text-primary)" }}>{name}</span>
        {detail ? (
          <ChevronRight size={12} style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
        ) : null}
      </button>
      {open && detail ? (
        <pre className="overflow-x-auto border-t px-2.5 py-2 font-mono text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}>
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
