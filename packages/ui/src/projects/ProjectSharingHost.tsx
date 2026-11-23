import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import type { CollaborationApi } from "../collaboration/ChatCollaboratorsDialog.js";
import { useProjectSharing } from "../collaboration/useProjectSharing.js";

/** Collaboration resolved once for a project list or project-creation flow. */
export interface ProjectSharingContext {
  api: CollaborationApi;
  runtimeId: string;
  organizationId: string | null;
  organizationStatus: "loading" | "member" | "unavailable";
}

export interface ProjectSharingHandle {
  start(): void;
}

/**
 * Keeps the project sharing dialogs mounted outside transient project menus
 * and outside the creation dialog that closes after a successful create.
 */
export function ProjectSharingHost({ ref, sharing, projectId, projectName, layers, startOnMount = false, onClose }: {
  ref?: Ref<ProjectSharingHandle>;
  sharing: ProjectSharingContext;
  projectId: string;
  projectName: string;
  layers: { popover: number };
  startOnMount?: boolean;
  onClose?: () => void;
}) {
  const flow = useProjectSharing({
    api: sharing.api,
    runtimeId: sharing.runtimeId,
    organizationId: sharing.organizationId,
    projectId,
    projectName,
    layers,
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
    {flow.error ? <p role="alert" className="px-2 text-xs" style={{ color: "var(--danger-text, var(--destructive))" }}>{flow.errorMessage}</p> : null}
    {flow.dialogs}
  </>;
}
