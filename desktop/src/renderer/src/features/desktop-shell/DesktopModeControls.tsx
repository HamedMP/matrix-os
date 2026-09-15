import AccountMenu from "../mission-control/AccountMenu";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopDiscordButton from "../support/DesktopDiscordButton";
import DesktopSupportButton from "../support/DesktopSupportButton";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import GettingStartedPopover from "../onboarding/GettingStartedPopover";
import { LayoutGrid, Monitor, Search } from "../../lib/hugeicons";
import { useUi } from "../../stores/ui";
import { useNativeDesktopMode, type NativeDesktopMode } from "../../stores/native-desktop-mode";

const MODES: Array<{
  id: NativeDesktopMode;
  label: string;
  icon: typeof Monitor;
}> = [
  { id: "desktop", label: "Desktop mode", icon: Monitor },
  { id: "canvas", label: "Canvas mode", icon: LayoutGrid },
];

export default function DesktopModeControls() {
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);
  const mode = useNativeDesktopMode((state) => state.mode);
  const setMode = useNativeDesktopMode((state) => state.setMode);
  return (
    <div className="no-drag ml-auto flex h-full shrink-0 items-center gap-2 border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
      <div
        role="group"
        aria-label="Workspace mode"
        className="flex h-7 shrink-0 items-center overflow-hidden rounded-md border p-0.5"
        style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}
      >
        {MODES.map((item) => {
          const selected = mode === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              aria-pressed={selected}
              title={item.label}
              className="flex size-6 shrink-0 items-center justify-center rounded outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{
                background: selected ? "var(--bg-surface)" : "transparent",
                color: selected ? "var(--text-primary)" : "var(--text-tertiary)",
                boxShadow: selected ? "var(--shadow-1)" : "none",
              }}
              onClick={() => setMode(item.id)}
            >
              <Icon aria-hidden="true" size={14} />
            </button>
          );
        })}
      </div>
      <button
        type="button"
        aria-label="Search"
        title="Search (Cmd+K)"
        className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
        style={{ color: "var(--text-secondary)" }}
        onClick={() => setPaletteOpen(true)}
      >
        <Search aria-hidden="true" size={16} />
      </button>
      <DesktopSupportButton />
      <DesktopDiscordButton />
      <div className="relative w-[156px]">
        <RuntimeComputerMenu collapsed={false} />
      </div>
      <GettingStartedPopover />
      <DesktopUpdateButton />
      <AccountMenu collapsed compact />
    </div>
  );
}
