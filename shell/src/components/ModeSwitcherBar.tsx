"use client";

import { useDesktopMode } from "@/stores/desktop-mode";

/**
 * Segmented mode switcher for the menu bar. A recessed pill track with one
 * raised segment per visible mode (Developer / Canvas), each with its own
 * icon. The active segment reads as a clean card lifted off the track;
 * inactive segments stay quiet until hovered.
 */
export function ModeSwitcherBar() {
  const mode = useDesktopMode((s) => s.mode);
  const setMode = useDesktopMode((s) => s.setMode);
  const modes = useDesktopMode((s) => s.visibleModes)();

  return (
    <div className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-foreground/[0.05] p-1">
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
            className={`group inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-[13px] font-medium leading-none transition-all duration-150 ${
              active
                ? "bg-card text-forest shadow-[0_1px_2px_rgba(50,53,46,0.16),0_0_0_1px_rgba(50,53,46,0.04)]"
                : "text-muted-foreground hover:text-forest/80"
            }`}
          >
            <Icon
              className={`size-4 transition-colors ${active ? "text-forest" : "text-muted-foreground group-hover:text-forest/70"}`}
              strokeWidth={2}
              aria-hidden="true"
            />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
