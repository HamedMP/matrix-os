import { invoke } from "../../lib/operator";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import DesktopHeaderTabs from "../desktop-shell/DesktopHeaderTabs";
import DesktopModeControls from "../desktop-shell/DesktopModeControls";

export default function NavigationHeader() {
  const handleTitlebarDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target;
    if (target instanceof Element && target.closest("button,input,a,[role='button'],[role='tab']")) return;
    void invoke("window:toggle-maximize", {});
  };

  return (
    <header
      className="titlebar-drag absolute inset-x-0 top-0 grid shrink-0 items-center"
      onDoubleClick={handleTitlebarDoubleClick}
      style={{
        zIndex: DESKTOP_Z_INDEX.chrome,
        height: "var(--titlebar-height)",
        gridTemplateColumns: "96px minmax(0, 1fr)",
        background: "color-mix(in srgb, var(--bg-sunken) 82%, transparent)",
        backdropFilter: "blur(68px)",
      }}
    >
      {/* Reserve the native traffic-light controls' drag region. */}
      <div />
      <div className="flex h-full min-w-0 items-center gap-1 px-2">
        <DesktopHeaderTabs />
        <DesktopModeControls />
      </div>
    </header>
  );
}
