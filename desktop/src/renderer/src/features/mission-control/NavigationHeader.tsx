import { invoke } from "../../lib/operator";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { desktopPlatform } from "../../lib/desktop-platform";
import { titlebarLayout } from "../../lib/titlebar-chrome";
import DesktopHeaderTabs from "../desktop-shell/DesktopHeaderTabs";
import DesktopModeControls from "../desktop-shell/DesktopModeControls";

export default function NavigationHeader() {
  const layout = titlebarLayout(desktopPlatform());
  const handleTitlebarDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button,input,a,[role='button'],[role='tab']")) return;
    void invoke("window:toggle-maximize", {});
  };

  return (
    <header
      className="native-titlebar titlebar-drag absolute inset-x-0 top-0 grid shrink-0 items-center border-b"
      onDoubleClick={handleTitlebarDoubleClick}
      style={{
        zIndex: DESKTOP_Z_INDEX.chrome,
        height: "var(--titlebar-height)",
        gridTemplateColumns: layout.gridTemplateColumns,
        background: layout.background,
        borderColor: "var(--border-subtle)",
        "--desktop-menu-z": DESKTOP_Z_INDEX.popover,
        backdropFilter: "blur(34px)",
      } as React.CSSProperties}
    >
      {layout.reservesLeftControls && <div aria-hidden="true" />}
      <div className="flex h-full min-w-0 items-center gap-0 pr-2">
        <DesktopHeaderTabs />
        <DesktopModeControls />
      </div>
    </header>
  );
}
