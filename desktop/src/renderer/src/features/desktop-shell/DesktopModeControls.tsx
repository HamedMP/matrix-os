import { useCallback, useMemo } from "react";
import { DesktopTopBarActions, DesktopActivityInbox } from "@matrix-os/ui";
import AccountMenu from "../mission-control/AccountMenu";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import GettingStartedPopover from "../onboarding/GettingStartedPopover";
import { openDesktopSupport } from "../support/DesktopSupportWidget";
import { invoke } from "../../lib/operator";
import { openCodingAgentThread } from "../../lib/project-chat";
import { openTerminalSession } from "../mission-control/navigation-roots";
import { useTerminalAgentEvents } from "../../stores/terminal-agent-events";
import { useConnection } from "../../stores/connection";
import { useDesktopUpdate } from "../../stores/desktop-update";
import { useUi } from "../../stores/ui";

// The native Terminal window ships on macOS and Linux only (spec 651).
const terminalWindowSupported = !/\bWindows\b/i.test(navigator.userAgent);

const openAgentThread = (id: string) => { void openCodingAgentThread(id); };

const menuOverlay = {
  acquire: () => useUi.getState().acquireRendererOverlay(),
  release: () => useUi.getState().releaseRendererOverlay(),
};

export default function DesktopModeControls() {
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);
  const generation = useConnection(state => state.authGeneration);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const terminalTabs = useTerminalAgentEvents(state => state.tabs);
  const openWhatsNew = useDesktopUpdate(state => state.openWhatsNew);
  const whatsNewUnseen = useDesktopUpdate(state => state.whatsNewUnseen);
  const whatsNew = useMemo(() => ({ unseen: whatsNewUnseen, open: openWhatsNew }), [openWhatsNew, whatsNewUnseen]);
  const loadActivity = useCallback(() => {
    // Capture the exact authenticated computer generation used by this request.
    if (useConnection.getState().authGeneration !== generation || useConnection.getState().runtimeSlot !== runtimeSlot) return Promise.reject(new Error("Runtime changed"));
    return invoke("runtime:get-summary", {});
  }, [generation, runtimeSlot]);
  const openSupport = () => { void openDesktopSupport(); };
  const openTerminalWindow = () => {
    void invoke("terminal-window:open", {}).catch((error: unknown) => {
      console.warn("[terminal-window] open failed:", error instanceof Error ? error.name : "UnknownError");
    });
  };
  return <div className="no-drag ml-auto flex h-full shrink-0 items-center border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
    <DesktopTopBarActions onSearch={() => setPaletteOpen(true)} onSupport={openSupport} onTerminal={terminalWindowSupported ? openTerminalWindow : undefined}
      inbox={<DesktopActivityInbox overlay={menuOverlay} scope={`${generation}:${runtimeSlot}`} load={loadActivity} terminalTabs={terminalTabs} onOpenTask={openAgentThread} onOpenTerminal={openTerminalSession} />}
      setup={<GettingStartedPopover />}
      computer={<RuntimeComputerMenu collapsed={false} />} update={<DesktopUpdateButton />} account={<AccountMenu collapsed compact whatsNew={whatsNew} />} />
  </div>;
}
