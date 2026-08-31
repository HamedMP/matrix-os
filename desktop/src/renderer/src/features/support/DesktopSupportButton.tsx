import { CircleHelp } from "../../lib/hugeicons";
import { useTabs } from "../../stores/tabs";
import { openHelpInMatrixBrowser } from "../browser/help-navigation";

export default function DesktopSupportButton() {
  const openTab = useTabs((state) => state.openTab);

  return (
    <button
      type="button"
      aria-label="Support"
      title="Support"
      className="flex size-7 shrink-0 items-center justify-center rounded-md outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)]"
      style={{ color: "var(--text-secondary)" }}
      onClick={() => {
        openHelpInMatrixBrowser(openTab);
      }}
    >
      <CircleHelp aria-hidden="true" size={16} />
    </button>
  );
}
