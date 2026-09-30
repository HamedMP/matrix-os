import { UsersIcon } from "@renderer/lib/hugeicons";
import { useRef, type ReactNode } from "react";
import {
  DesktopProjectSharingHost,
  type DesktopProjectSharingContext,
  type DesktopProjectSharingHandle,
} from "../../project/DesktopProjectSharing";
import type { WorkRailProjectGroup } from "../work-rail-model";
import type { ProjectMenuAction } from "./ProjectActionsMenu";

/** Add whole-project sharing to the Chats project actions menu. */
export function useProjectShareAction(
  group: Pick<WorkRailProjectGroup, "name" | "project">,
  sharing: DesktopProjectSharingContext | null,
): { items: ProjectMenuAction[]; host: ReactNode } {
  const hostRef = useRef<DesktopProjectSharingHandle>(null);
  const projectId = group.project.id;
  if (!sharing || !projectId) return { items: [], host: null };
  return {
    items: [{
      label: sharing.organizationId ? "Share project" : "Join an organization to share",
      icon: <UsersIcon size={16} aria-hidden />,
      disabled: !sharing.organizationId,
      onSelect: () => hostRef.current?.start(),
    }],
    host: <DesktopProjectSharingHost key={sharing.organizationId ?? "no-organization"} ref={hostRef}
      sharing={sharing} projectId={projectId} projectName={group.name} />,
  };
}
