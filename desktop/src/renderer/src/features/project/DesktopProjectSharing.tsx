import { ProjectSharingButton } from "@matrix-os/ui";
import { useEffect, useMemo, useState } from "react";
import { collaborationRuntimeIdFromSystemInfo, createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";

export function DesktopProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const collaborationApi = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    if (!gatewayApi || typeof gatewayApi.get !== "function") return () => { active = false; };
    void gatewayApi.get<unknown>("/api/system/info").then((value) => {
      if (active) setRuntimeId(collaborationRuntimeIdFromSystemInfo(value));
    }).catch((error: unknown) => {
      console.warn("[project-collaboration] runtime identity unavailable", error instanceof Error ? error.name : "UnknownError");
    });
    return () => { active = false; };
  }, [gatewayApi]);
  return collaborationApi
    ? <ProjectSharingButton api={collaborationApi} runtimeId={runtimeId} projectId={projectId} projectName={projectName} />
    : null;
}
