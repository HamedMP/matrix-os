import { ChevronRight, Wrench } from "lucide-react";
import { useState } from "react";
import { Marker, MarkerContent, MarkerIcon } from "./marker";

// Tool invocation row: a Marker-style one-liner (icon, name, disclosure) that
// expands to reveal bounded detail. Replaces the old bordered card.
export function Tool({ name, detail }: { name: string; detail?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col">
      <Marker asChild>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="rounded-md px-1 py-0.5 hover:bg-[var(--bg-hover)]"
        >
          <MarkerIcon>
            <Wrench className="size-3.5" style={{ color: "var(--text-tertiary)" }} />
          </MarkerIcon>
          <MarkerContent className="truncate font-medium text-[var(--text-primary)]">{name}</MarkerContent>
          {detail ? (
            <ChevronRight className="size-3.5" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 120ms" }} />
          ) : null}
        </button>
      </Marker>
      {open && detail ? (
        <pre
          className="mt-1 ml-7 overflow-x-auto border-l pl-3 font-mono text-xs"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-secondary)" }}
        >
          {detail}
        </pre>
      ) : null}
    </div>
  );
}
