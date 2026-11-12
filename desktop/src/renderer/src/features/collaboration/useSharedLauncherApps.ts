import { useSharedAppDirectory } from "@matrix-os/ui/collaborative-app-sharing";
import { useConnection } from "../../stores/connection";
import { useDesktopCollaborationApi } from "./DesktopCollaborationOrganization";

export function useSharedLauncherApps(enabled: boolean) {
  const host = useConnection((state) => state.platformHost);
  const actorId = useConnection((state) => state.userId);
  const organizationId = useConnection((state) => state.organizationId);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const generation = useConnection((state) => state.authGeneration);
  const identity = `${host}:${actorId ?? ""}:${organizationId ?? ""}:${generation ?? ""}`;
  const api = useDesktopCollaborationApi(host, enabled && !!actorId && organizationStatus !== "none", identity);
  return useSharedAppDirectory(api, identity, enabled);
}
