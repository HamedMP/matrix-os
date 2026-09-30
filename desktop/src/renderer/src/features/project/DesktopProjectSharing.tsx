import {
  PROJECT_SHARING_UNAVAILABLE_MESSAGE,
  ProjectSharingButton,
  useProjectSharing,
  type CollaborationDirectApi,
} from "@matrix-os/ui";
import { useImperativeHandle, useMemo, type Ref } from "react";
import { createDesktopCollaborationApi } from "../../lib/collaboration";
import { useConnection } from "../../stores/connection";
import { DesktopCollaborationOrganization } from "../collaboration/DesktopCollaborationOrganization";
import { useCollaborationRuntimeId } from "../collaboration/useCollaborationRuntime";

export function DesktopProjectSharing({ projectId, projectName }: { projectId: string; projectName: string }) {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const collaborationApi = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const runtimeId = useCollaborationRuntimeId(gatewayApi);
  return collaborationApi && runtimeId
    ? <DesktopCollaborationOrganization>{(organizationId) => <ProjectSharingButton api={collaborationApi}
      runtimeId={runtimeId} organizationId={organizationId} projectId={projectId} projectName={projectName} />}</DesktopCollaborationOrganization>
    : null;
}

export interface DesktopProjectSharingContext {
  api: CollaborationDirectApi;
  runtimeId: string;
  organizationId: string | null;
}

/**
 * Collaboration context for project Share actions, resolved once per list of
 * projects: null while this computer does not offer collaboration.
 */
export function useDesktopProjectSharingContext(): DesktopProjectSharingContext | null {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationId = useConnection((state) => state.organizationId);
  const api = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const runtimeId = useCollaborationRuntimeId(gatewayApi);
  return api && runtimeId ? { api, runtimeId, organizationId } : null;
}

export interface DesktopProjectSharingHandle {
  start(): void;
}

/**
 * Owns the whole-project sharing flow for a Share action that lives in a menu
 * (the Work rail project actions): the menu item unmounts when it closes, so
 * the flow's dialogs and error stay here. Key it by organization so a switch
 * leaves no preflight or open scope behind.
 */
export function DesktopProjectSharingHost({ ref, sharing, projectId, projectName }: {
  ref?: Ref<DesktopProjectSharingHandle>;
  sharing: DesktopProjectSharingContext;
  projectId: string;
  projectName: string;
}) {
  const flow = useProjectSharing({
    api: sharing.api,
    runtimeId: sharing.runtimeId,
    organizationId: sharing.organizationId,
    projectId,
    projectName,
  });
  useImperativeHandle(ref, () => ({ start: flow.start }));
  return <>
    {flow.error ? <p role="alert" className="px-2 text-xs" style={{ color: "var(--danger)" }}>{PROJECT_SHARING_UNAVAILABLE_MESSAGE}</p> : null}
    {flow.dialogs}
  </>;
}
