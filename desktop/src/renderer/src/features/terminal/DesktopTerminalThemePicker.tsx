import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Palette } from "@renderer/lib/hugeicons";

import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { useTerminalAppearance } from "../../stores/terminal-appearance";
import {
  getTerminalThemePreset,
  TERMINAL_THEME_OPTIONS,
} from "../../lib/terminal/terminal-themes";
import type { TerminalThemeId } from "../../lib/terminal/terminal-settings-types";

function isTerminalThemeId(value: string): value is TerminalThemeId {
  return TERMINAL_THEME_OPTIONS.some((option) => option.id === value);
}

export function DesktopTerminalThemePicker() {
  const api = useConnection((state) => state.api);
  const themeId = useTerminalAppearance((state) => state.themeId);
  const setThemeId = useTerminalAppearance((state) => state.setThemeId);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Shell theme"
          title="Shell theme"
          disabled={!api}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            background: "var(--bg-surface)",
            borderColor: "var(--border-subtle)",
            color: "var(--text-primary)",
          }}
        >
          <Palette size={14} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Shell theme"
          side="bottom"
          align="end"
          sideOffset={6}
          className="max-h-[min(440px,calc(100vh-32px))] min-w-[270px] overflow-y-auto rounded-xl border p-2 shadow-xl"
          style={{
            zIndex: DESKTOP_Z_INDEX.popover,
            background: "var(--bg-overlay)",
            borderColor: "var(--border-subtle)",
            color: "var(--text-primary)",
          }}
        >
          <p className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--text-tertiary)" }}>
            Shell colors
          </p>
          <DropdownMenu.RadioGroup
            value={themeId}
            onValueChange={(value) => {
              if (api && isTerminalThemeId(value)) setThemeId(value, api);
            }}
          >
            {TERMINAL_THEME_OPTIONS.map((option) => {
              const preset = getTerminalThemePreset(option.id);
              return (
                <DropdownMenu.RadioItem
                  key={option.id}
                  value={option.id}
                  disabled={!api}
                  className="flex cursor-default items-center gap-3 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-[var(--bg-hover)]"
                  style={{ background: option.id === themeId ? "var(--bg-selected)" : undefined }}
                >
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center gap-0.5 rounded-lg border px-1.5"
                    style={{ background: preset.background, borderColor: "var(--border-subtle)" }}
                  >
                    <span className="h-1.5 w-1.5 rounded-full" style={{ background: preset.green }} />
                    <span className="h-1.5 w-2.5 rounded-sm" style={{ background: preset.blue }} />
                    <span className="h-1.5 w-2 rounded-sm" style={{ background: preset.magenta }} />
                  </span>
                  <span className="min-w-0 flex-1 text-sm font-medium">{option.label}</span>
                  <span className="flex w-4 items-center justify-center">
                    <DropdownMenu.ItemIndicator>
                      <Check size={14} aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                </DropdownMenu.RadioItem>
              );
            })}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
