import AccountMenu from "../mission-control/AccountMenu";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopSupportButton from "../support/DesktopSupportButton";

export default function DesktopModeControls() {
  return (
    <div className="no-drag ml-auto flex h-full shrink-0 items-center gap-2 border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
      <div className="relative w-[156px]">
        <RuntimeComputerMenu collapsed={false} />
      </div>
      <DesktopSupportButton />
      <AccountMenu collapsed compact />
    </div>
  );
}
