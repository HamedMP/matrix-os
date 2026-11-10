import { isPrivatePreviewHandle } from "@matrix-os/contracts";
import { BotsWorkspace } from "@matrix-os/ui";
import { useMemo } from "react";
import { useConnection } from "../../stores/connection";

export function useDesktopHostedBots() {
  const api = useConnection((state) => state.api);
  const runtimeSlot = useConnection((state) => state.runtimeSlot);
  const platformHost = useConnection((state) => state.platformHost);
  const userId = useConnection((state) => state.userId);
  const generation = useConnection((state) => state.authGeneration);
  const scope = JSON.stringify([platformHost, runtimeSlot, userId, generation]);
  const transport = useMemo(() => isPrivatePreviewHandle(runtimeSlot)
    ? api?.forRuntime(runtimeSlot) ?? null
    : null, [api, runtimeSlot, generation, userId]);
  return { transport, scope };
}

export function DesktopBotsWorkspace({ active }: { active: boolean }) {
  const { transport, scope } = useDesktopHostedBots();
  return <BotsWorkspace key={scope} transport={transport} active={active} />;
}
