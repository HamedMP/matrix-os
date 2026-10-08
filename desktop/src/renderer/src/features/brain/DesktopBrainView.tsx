import { BrainApp, createBrainShellApi, listBrainProjects } from "@matrix-os/ui";
import { useMemo } from "react";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration } from "../../stores/runtime-generation";
import { desktopBrainTransport } from "./brain-transport";

/** Company Brain in Electron Desktop: the shared view over the desktop gateway client, pinned to one runtime. */
export default function DesktopBrainView() {
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
    <BrainApp
      key={`${slot}:${authGeneration}:${captureRuntimeGeneration()}`}
      api={clients.api}
      loadProjects={clients.loadProjects}
      showHeading={false}
    />
  );
}
