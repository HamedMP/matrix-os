"use client";

import { useDesktopMode } from "@/stores/desktop-mode";

/**
 * Tab strip for the desktop top bar. The mode state and handlers are unchanged;
 * only its presentation follows the desktop-shell tab treatment.
 */
export function ModeSwitcherBar() {
  const mode = useDesktopMode((s) => s.mode);
  const setMode = useDesktopMode((s) => s.setMode);
  const modes = useDesktopMode((s) => s.visibleModes)();

  return (
    <div className="flex h-full items-stretch">
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
            className={`inline-flex h-full items-center gap-1.5 border-l border-black/[0.06] px-3 text-[12px] font-medium leading-none transition-colors first:border-l-0 dark:border-white/[0.1] ${
              active
                ? "bg-white/35 !text-[#242323] shadow-[inset_0_-2px_0_#748e59] dark:bg-white/10 dark:!text-foreground"
                : "!text-[#242323]/55 hover:bg-black/[0.04] hover:!text-[#242323] dark:!text-muted-foreground dark:hover:bg-white/10 dark:hover:!text-foreground"
            }`}
          >
            <Icon className="size-3.5 shrink-0" strokeWidth={2} aria-hidden="true" />
            <span className="hidden lg:inline">{m.label}</span>
          </button>
        );
      })}
    </div>
  );
}
