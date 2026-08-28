import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, Sparkles } from "@renderer/lib/hugeicons";

import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useTerminalAppearance } from "../../stores/terminal-appearance";
import {
  DESKTOP_TERMINAL_APP_THEME_OPTIONS,
  getDesktopTerminalAppCssVars,
  isDesktopTerminalAppThemeId,
} from "./terminal-app-theme";

export function DesktopTerminalThemePicker() {
  const appThemeId = useTerminalAppearance((state) => state.appThemeId);
  const setAppThemeId = useTerminalAppearance((state) => state.setAppThemeId);
  const cssVars = getDesktopTerminalAppCssVars(appThemeId);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Theme"
          className="inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-sm font-medium outline-none transition-transform hover:scale-[1.02] focus-visible:ring-2"
          style={{
            background: "var(--terminal-drawer-card-bg)",
            borderColor: "var(--terminal-drawer-border)",
            color: "var(--terminal-drawer-fg)",
          }}
        >
          <Sparkles size={14} aria-hidden="true" />
          Theme
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          aria-label="Terminal app theme"
          side="top"
          align="start"
          sideOffset={8}
          className="min-w-[250px] rounded-xl border p-2 shadow-xl"
          style={{
            zIndex: DESKTOP_Z_INDEX.popover,
            background: cssVars["--terminal-drawer-bg"],
            borderColor: cssVars["--terminal-drawer-border"],
            color: cssVars["--terminal-drawer-fg"],
          }}
        >
          <p className="px-2 pb-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: cssVars["--terminal-drawer-muted"] }}>
            Theme
          </p>
          <DropdownMenu.RadioGroup
            value={appThemeId}
            onValueChange={(value) => {
              if (isDesktopTerminalAppThemeId(value)) setAppThemeId(value);
            }}
          >
            {DESKTOP_TERMINAL_APP_THEME_OPTIONS.map((option) => (
              <DropdownMenu.RadioItem
                key={option.id}
                value={option.id}
                className="flex cursor-default items-center gap-3 rounded-lg px-2 py-2 outline-none data-[highlighted]:brightness-110"
                style={{
                  background: option.id === appThemeId
                    ? cssVars["--terminal-drawer-card-selected-bg"]
                    : "transparent",
                }}
              >
                <span
                  aria-hidden="true"
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg border"
                  style={{
                    background: option.id === "light" ? "#FFFDF7" : option.id === "matrix" ? "#08110B" : "#15180F",
                    borderColor: cssVars["--terminal-drawer-border"],
                    color: option.id === "matrix" ? "#39FF6A" : option.id === "light" ? "#465243" : "#9CB77A",
                  }}
                >
                  <span className="h-0.5 w-4 rounded-full bg-current" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{option.name}</span>
                  <span className="block text-xs" style={{ color: cssVars["--terminal-drawer-muted"] }}>{option.description}</span>
                </span>
                <span className="flex w-4 items-center justify-center">
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} aria-hidden="true" />
                  </DropdownMenu.ItemIndicator>
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
