import { TerminalSharingButton } from "@matrix-os/ui";
import { useEffect, useMemo, useState } from "react";
import { collaborationRuntimeIdFromSystemInfo, createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

export function DesktopTerminalSharing({ terminalId }: { terminalId: string }) {
  const api = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const collaborationApi = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!api) return () => { active = false; };
    void api.get("/api/system/info", { maxBytes: 64 * 1024 }).then((value) => {
      if (active) setRuntimeId(collaborationRuntimeIdFromSystemInfo(value));
    }).catch((error: unknown) => {
      console.warn("[terminal-collaboration] runtime identity unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, [api]);
  return collaborationApi
    ? <TerminalSharingButton api={collaborationApi} runtimeId={runtimeId} terminalId={terminalId} />
    : null;
}
