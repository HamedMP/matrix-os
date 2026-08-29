import AccountMenu from "../mission-control/AccountMenu";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopSupportButton from "../support/DesktopSupportButton";
import { Search } from "../../lib/hugeicons";
import { useUi } from "../../stores/ui";

export default function DesktopModeControls() {
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);
  return (
    <div className="no-drag ml-auto flex h-full shrink-0 items-center gap-2 border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
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
      <div className="relative w-[156px]">
        <RuntimeComputerMenu collapsed={false} />
      </div>
      <DesktopSupportButton />
      <AccountMenu collapsed compact />
    </div>
  );
}
