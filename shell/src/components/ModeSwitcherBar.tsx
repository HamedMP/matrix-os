"use client";

import { useDesktopMode } from "@/stores/desktop-mode";

export function ModeSwitcherBar() {
  const mode = useDesktopMode((s) => s.mode);
  const setMode = useDesktopMode((s) => s.setMode);
  const modes = useDesktopMode((s) => s.visibleModes)();

  return (
    <div className="inline-flex items-center gap-0.5 rounded-[9px] border border-border bg-foreground/[0.04] p-0.5">
      {modes.map((m) => {
        const Icon = m.icon;
        const active = mode === m.id;
        return (
          <button
            key={m.id}
            type="button"
            aria-pressed={active}
            aria-label={`${m.label} mode`}
            onClick={() => setMode(m.id)}
            title={m.description}
            className={`inline-flex items-center gap-1.5 rounded-[7px] px-3 py-1.5 text-xs font-medium transition-colors ${
              active ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-[14px]" aria-hidden="true" />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
