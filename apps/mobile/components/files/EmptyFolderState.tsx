import FolderOpenIcon from "@hugeicons/core-free-icons/FolderOpenIcon";

import { EmptyState } from "@/components/ui";

export function EmptyFolderState() {
  return (
    <EmptyState
      icon={FolderOpenIcon}
      message="this folder is currently empty"
      testID="empty-folder-state"
      iconTestID="empty-folder-icon"
    />
  );
}
