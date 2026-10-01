import { UsersIcon } from "@renderer/lib/hugeicons";
import type { DesktopProjectSharingContext } from "../../project/DesktopProjectSharing";
import type { WorkRailProjectGroup } from "../work-rail-model";
import type { ProjectMenuAction } from "./ProjectActionsMenu";

/** Add whole-project sharing to the Chats project actions menu. */
export function projectShareMenuItems(
  group: Pick<WorkRailProjectGroup, "name" | "project">,
  sharing: DesktopProjectSharingContext | null,
  onShare?: (project: WorkRailProjectGroup["project"]) => void,
): ProjectMenuAction[] {
  const projectId = group.project.id;
  if (!sharing || !projectId || !onShare) return [];
  return [{
    label: sharing.organizationId ? "Share project" : "Join an organization to share",
    icon: <UsersIcon size={16} aria-hidden />,
    disabled: !sharing.organizationId,
    onSelect: () => onShare(group.project),
  }];
}
