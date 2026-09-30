import {
  PROJECT_SHARING_UNAVAILABLE_MESSAGE,
  ProjectSharingButton,
  useProjectSharing,
  type CollaborationDirectApi,
} from "@matrix-os/ui";
import { useEffect, useImperativeHandle, useMemo, useRef, type Ref } from "react";
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

/** Resolve collaboration once for a project list or project-creation flow. */
export function useDesktopProjectSharingContext(enabled = true): DesktopProjectSharingContext | null {
  const gatewayApi = useConnection((state) => state.api);
  const platformHost = useConnection((state) => state.platformHost);
  const organizationId = useConnection((state) => state.organizationId);
  const api = useMemo(() => createDesktopCollaborationApi(platformHost), [platformHost]);
  const runtimeId = useCollaborationRuntimeId(enabled ? gatewayApi : null);
  return useMemo(
    () => enabled && api && runtimeId ? { api, runtimeId, organizationId } : null,
    [api, enabled, organizationId, runtimeId],
  );
}

export interface DesktopProjectSharingHandle {
  start(): void;
}

/**
 * Keeps the project sharing dialogs mounted outside transient project menus
 * and outside the creation dialog that closes after a successful create.
 */
export function DesktopProjectSharingHost({ ref, sharing, projectId, projectName, startOnMount = false, onClose }: {
  ref?: Ref<DesktopProjectSharingHandle>;
  sharing: DesktopProjectSharingContext;
  projectId: string;
  projectName: string;
  startOnMount?: boolean;
  onClose?: () => void;
}) {
  const flow = useProjectSharing({
    api: sharing.api,
    runtimeId: sharing.runtimeId,
    organizationId: sharing.organizationId,
    projectId,
    projectName,
    onClose,
  });
  useImperativeHandle(ref, () => ({ start: flow.start }));
  const startedOnMount = useRef(false);
  useEffect(() => {
    if (!startOnMount || startedOnMount.current) return;
    startedOnMount.current = true;
    flow.start();
  }, [flow, startOnMount]);
  return <>
    {flow.error ? <p role="alert" className="px-2 text-xs" style={{ color: "var(--danger)" }}>{PROJECT_SHARING_UNAVAILABLE_MESSAGE}</p> : null}
    {flow.dialogs}
  </>;
}
