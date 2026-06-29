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
    <div className="inline-flex h-[22px] items-center gap-0.5 rounded-full border border-border/50 bg-foreground/[0.06] p-[2px]">
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
            className={`inline-flex h-full items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium leading-none transition-colors ${
              active
                ? "bg-card !text-forest shadow-[0_1px_2px_rgba(50,53,46,0.14)]"
                : "!text-muted-foreground hover:!text-forest/80"
            }`}
          >
            <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
