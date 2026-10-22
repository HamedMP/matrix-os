import { useCallback } from "react";
import { DesktopTopBarActions, DesktopActivityInbox } from "@matrix-os/ui";
import AccountMenu from "../mission-control/AccountMenu";
import RuntimeComputerMenu from "../runtime/RuntimeComputerMenu";
import DesktopUpdateButton from "../updates/DesktopUpdateButton";
import GettingStartedPopover from "../onboarding/GettingStartedPopover";
import { openDesktopSupport } from "../support/DesktopSupportWidget";
import discordIconUrl from "../../../../../../shell/public/system-app-icons/v3/discord.svg";
import { invoke } from "../../lib/operator";
import { openCodingAgentThread } from "../../lib/project-chat";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";

const menuOverlay = {
  acquire: () => useUi.getState().acquireRendererOverlay(),
  release: () => useUi.getState().releaseRendererOverlay(),
};

export default function DesktopModeControls() {
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);
  const generation = useConnection(state => state.authGeneration);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const loadActivity = useCallback(() => {
    // Capture the exact authenticated computer generation used by this request.
    if (useConnection.getState().authGeneration !== generation || useConnection.getState().runtimeSlot !== runtimeSlot) return Promise.reject(new Error("Runtime changed"));
    return invoke("runtime:get-summary", {});
  }, [generation, runtimeSlot]);
  return <div className="no-drag ml-auto flex h-full shrink-0 items-center border-l pl-3" style={{ borderColor: "var(--border-subtle)" }}>
    <DesktopTopBarActions onSearch={() => setPaletteOpen(true)}
      inbox={<DesktopActivityInbox overlay={menuOverlay} scope={`${generation}:${runtimeSlot}`} load={loadActivity} onOpenTask={id => { void openCodingAgentThread(id); }} />}
      help={<GettingStartedPopover helpMenu={{ onSupport: () => { void openDesktopSupport(); }, discordIcon: <span aria-hidden="true" className="size-3.5 shrink-0 bg-current" style={{ mask: `url(${discordIconUrl}) center/contain no-repeat` }} /> }} />}
      computer={<RuntimeComputerMenu collapsed={false} />} update={<DesktopUpdateButton />} account={<AccountMenu collapsed compact />} />
  </div>;
}
