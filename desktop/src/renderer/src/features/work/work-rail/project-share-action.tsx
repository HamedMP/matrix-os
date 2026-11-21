import { projectShareMenuItem, type ProjectMenuAction } from "@matrix-os/ui";
import type { DesktopProjectSharingContext } from "../../project/DesktopProjectSharing";
import type { WorkRailProjectGroup } from "../work-rail-model";

/** Add whole-project sharing to the Chats project actions menu. */
export function projectShareMenuItems(
  group: Pick<WorkRailProjectGroup, "name" | "project">,
  sharing: DesktopProjectSharingContext | null,
  onShare?: (project: WorkRailProjectGroup["project"]) => void,
): ProjectMenuAction[] {
  if (!group.project.id) return [];
  return projectShareMenuItem(sharing, onShare ? () => onShare(group.project) : undefined);
}
