import {
  ProjectSharingButton,
  ProjectSharingHost,
  type CollaborationDirectApi,
  type ProjectSharingHandle,
} from "@matrix-os/ui";
import { useMemo, type Ref } from "react";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization, useDesktopCollaborationApi } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

const PROJECT_SHARING_LAYERS = { popover: DESKTOP_Z_INDEX.popover };

export function DesktopProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const collaborationApi = useDesktopCollaborationApi(platformHost, organizationStatus !== "none");
  const runtimeId = useCollaborationRuntimeId(organizationStatus !== "none" ? gatewayApi : null);
  return collaborationApi && runtimeId
    ? <DesktopCollaborationOrganization>{(organizationId) => <ProjectSharingButton api={collaborationApi}
      runtimeId={runtimeId} organizationId={organizationId} projectId={projectId} projectName={projectName}
      layers={PROJECT_SHARING_LAYERS} />}</DesktopCollaborationOrganization>
    : null;
}

export interface DesktopProjectSharingContext {
  api: CollaborationDirectApi;
  runtimeId: string;
  organizationId: string | null;
  organizationStatus: "loading" | "member" | "unavailable";
}

/** Resolve collaboration once for a project list or project-creation flow. */
export function useDesktopProjectSharingContext(enabled = true): DesktopProjectSharingContext | null {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationId = useConnection((state) => state.organizationId);
  const organizationStatus = useConnection((state) => state.organizationStatus);
  const verifiedOrganizationId = organizationStatus === "member" ? organizationId : null;
  const api = useDesktopCollaborationApi(platformHost, organizationStatus !== "none");
  const runtimeId = useCollaborationRuntimeId(enabled && organizationStatus !== "none" ? gatewayApi : null);
  return useMemo(
    () => enabled && organizationStatus !== "none" && api && runtimeId
      ? { api, runtimeId, organizationId: verifiedOrganizationId, organizationStatus }
      : null,
    [api, enabled, organizationStatus, runtimeId, verifiedOrganizationId],
  );
}

export type DesktopProjectSharingHandle = ProjectSharingHandle;

/**
 * Keeps the project sharing dialogs mounted outside transient project menus
 * and outside the creation dialog that closes after a successful create.
 */
export function DesktopProjectSharingHost(props: {
  ref?: Ref<DesktopProjectSharingHandle>;
  sharing: DesktopProjectSharingContext;
  projectId: string;
  projectName: string;
  startOnMount?: boolean;
  onClose?: () => void;
}) {
  return <ProjectSharingHost {...props} layers={PROJECT_SHARING_LAYERS} />;
}
