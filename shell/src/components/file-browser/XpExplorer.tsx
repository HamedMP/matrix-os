"use client";

import { useState } from "react";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { FileContextMenu } from "./FileContextMenu";
import { SearchResults } from "./SearchResults";
import { TrashView } from "./TrashView";
import { ListView } from "./ListView";
import { ColumnView } from "./ColumnView";
import { XpToolbar } from "./XpToolbar";
import { XpAddressBar } from "./XpAddressBar";
import { XpTaskPane } from "./XpTaskPane";
import { XpTilesView } from "./XpTilesView";
import { XpStatusBar } from "./XpStatusBar";
import "./xp-explorer.css";

interface XpExplorerProps {
  renamingPath: string | null;
  onStartRename: (name: string) => void;
  onCancelRename: () => void;
  onOpenFile: (path: string) => void;
  showingTrash: boolean;
  onTrashClick: () => void;
}

/**
 * Windows XP Explorer layout for the Files app. Rendered by FileBrowser only
 * while the winxp design style is active; every action routes through the
 * shared useFileBrowser store so navigation, selection, search, trash and
 * clipboard behavior stay identical to the classic UI.
 */
export function XpExplorer({
  renamingPath,
  onStartRename,
  onCancelRename,
  onOpenFile,
  showingTrash,
  onTrashClick,
}: XpExplorerProps) {
  const viewMode = useFileBrowser((s) => s.viewMode);
  const loading = useFileBrowser((s) => s.loading);
  const entries = useFileBrowser((s) => s.entries);
  const searchResults = useFileBrowser((s) => s.searchResults);
  const [taskPaneOpen, setTaskPaneOpen] = useState(true);

  let main: React.ReactNode;
  if (showingTrash) {
    main = <TrashView />;
  } else if (searchResults) {
    main = <SearchResults onOpenFile={onOpenFile} />;
  } else if (loading) {
    main = (
      <div className="xp-main-status">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Loading...
      </div>
    );
  } else if (entries.length === 0) {
    main = (
      <div className="xp-main-status">
        <FolderOpenIcon className="size-4" aria-hidden="true" />
        Empty folder
      </div>
    );
  } else if (viewMode === "list") {
    main = (
      <ListView
        renamingPath={renamingPath}
        onStartRename={onStartRename}
        onCancelRename={onCancelRename}
        onOpenFile={onOpenFile}
      />
    );
  } else if (viewMode === "column") {
    main = <ColumnView onOpenFile={onOpenFile} />;
  } else {
    main = (
      <XpTilesView
        renamingPath={renamingPath}
        onCancelRename={onCancelRename}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <div className="xp-explorer">
      <XpToolbar
        taskPaneOpen={taskPaneOpen}
        onToggleTaskPane={() => setTaskPaneOpen((v) => !v)}
      />
      <XpAddressBar />
      <div className="xp-explorer-body">
        {taskPaneOpen && (
          <XpTaskPane
            showingTrash={showingTrash}
            onTrashClick={onTrashClick}
            onStartRename={onStartRename}
          />
        )}
        <FileContextMenu onOpenFile={onOpenFile}>
          {/* ph-no-capture: the listing renders file names from the user home;
              PostHog session replay blocks this element natively. */}
          <div className="ph-no-capture xp-explorer-main">{main}</div>
        </FileContextMenu>
      </div>
      <XpStatusBar />
    </div>
  );
}
