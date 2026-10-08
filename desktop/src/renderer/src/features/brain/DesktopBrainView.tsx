import { BrainApp, createBrainShellApi, listBrainProjects, type BrainShellClient, type BrainProjectOption } from "@matrix-os/ui";
import { useMemo } from "react";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration } from "../../stores/runtime-generation";
import { WorkSurfaceRuntimeProvider } from "../work/WorkSurfaceRuntime";
import { desktopBrainTransport } from "./brain-transport";
import { useDesktopBrainChatHost } from "./DesktopBrainChat";

function DesktopBrainApp({ api, loadProjects, visible }: {
  api: BrainShellClient; loadProjects: () => Promise<readonly BrainProjectOption[]>; visible: boolean;
}) {
  const chat = useDesktopBrainChatHost(visible);
  return <BrainApp api={api} loadProjects={loadProjects} chat={chat} showHeading={false} />;
}

/**
 * Company Brain in Electron Desktop: the shared view over the desktop gateway client, pinned to one runtime. Its Chat
 * tab runs on the same chat client and event stream a Chat tab uses, streaming only while the tab is visible.
 */
export default function DesktopBrainView({ visible = true }: { visible?: boolean }) {
  const api = useConnection((state) => state.api);
  const slot = useConnection((state) => state.runtimeSlot);
  const authGeneration = useConnection((state) => state.authGeneration);
  const clients = useMemo(() => {
    if (!api) return null;
    const transport = desktopBrainTransport(api.forRuntime(slot));
    return { api: createBrainShellApi(transport), loadProjects: () => listBrainProjects(transport) };
  }, [api, slot]);
  if (!clients) {
    return (
      <div className="m-auto text-sm text-[var(--text-tertiary)]">
        Connect to your Matrix computer to open the Company Brain.
      </div>
    );
  }
  // A runtime switch or a new sign-in remounts the view, so no answer from the old session can land.
  return (
    <WorkSurfaceRuntimeProvider active={visible}>
      <DesktopBrainApp
        key={`${slot}:${authGeneration}:${captureRuntimeGeneration()}`}
        api={clients.api}
        loadProjects={clients.loadProjects}
        visible={visible}
      />
    </WorkSurfaceRuntimeProvider>
  );
}
