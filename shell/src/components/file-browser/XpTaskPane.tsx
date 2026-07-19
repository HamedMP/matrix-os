"use client";

import { useState } from "react";
import {
  CopyIcon,
  FilesIcon,
  FolderPlusIcon,
  PencilIcon,
  Trash2Icon,
} from "lucide-react";
import { useFileBrowser } from "@/hooks/useFileBrowser";
import { FILE_BROWSER_LOCATIONS } from "./file-browser-locations";
import {
  XpChevronGlyph,
  XpComputerGlyph,
  XpFileGlyph,
  XpFolderGlyph,
} from "./xp-icons";
import { formatXpSize, xpFileMarkColor, xpTypeLabel } from "./xp-file-meta";

interface XpTaskPaneProps {
  showingTrash: boolean;
  onTrashClick: () => void;
  onStartRename: (name: string) => void;
}

export function XpTaskPane({ showingTrash, onTrashClick, onStartRename }: XpTaskPaneProps) {
  const currentPath = useFileBrowser((s) => s.currentPath);
  const entries = useFileBrowser((s) => s.entries);
  const selectedPaths = useFileBrowser((s) => s.selectedPaths);
  const navigate = useFileBrowser((s) => s.navigate);
  const createFolder = useFileBrowser((s) => s.createFolder);
  const copy = useFileBrowser((s) => s.copy);
  const duplicate = useFileBrowser((s) => s.duplicate);
  const deleteFiles = useFileBrowser((s) => s.deleteFiles);

  const selected = entries.filter((e) => selectedPaths.has(e.name));
  const single = selected.length === 1 ? selected[0] : null;
  const fullPath = (name: string) => (currentPath ? `${currentPath}/${name}` : name);

  return (
    <aside className="xp-task-pane" aria-label="Common tasks">
      <XpPane title="File and Folder Tasks">
        <button
          type="button"
          className="xp-task-link"
          onClick={() => createFolder("New Folder")}
        >
          <FolderPlusIcon className="size-3.5 shrink-0" aria-hidden="true" />
          New Folder
        </button>
        {single && (
          <>
            <button
              type="button"
              className="xp-task-link"
              onClick={() => onStartRename(single.name)}
            >
              <PencilIcon className="size-3.5 shrink-0" aria-hidden="true" />
              Rename
            </button>
            <button
              type="button"
              className="xp-task-link"
              onClick={() => copy([fullPath(single.name)])}
            >
              <CopyIcon className="size-3.5 shrink-0" aria-hidden="true" />
              Copy
            </button>
            <button
              type="button"
              className="xp-task-link"
              onClick={() => duplicate([fullPath(single.name)])}
            >
              <FilesIcon className="size-3.5 shrink-0" aria-hidden="true" />
              Duplicate
            </button>
            <button
              type="button"
              className="xp-task-link"
              onClick={() => deleteFiles([fullPath(single.name)])}
            >
              <Trash2Icon className="size-3.5 shrink-0" aria-hidden="true" />
              Move to Trash
            </button>
          </>
        )}
      </XpPane>

      <XpPane title="Other Places">
        <button type="button" className="xp-task-link" onClick={() => navigate("")}>
          <XpComputerGlyph size={16} />
          Home
        </button>
        {FILE_BROWSER_LOCATIONS.map((loc) => {
          const Icon = loc.icon;
          return (
            <button
              key={loc.path}
              type="button"
              className="xp-task-link"
              onClick={() => navigate(loc.path)}
            >
              <Icon className="size-3.5 shrink-0" aria-hidden="true" />
              {loc.name}
            </button>
          );
        })}
        <button
          type="button"
          className="xp-task-link"
          aria-pressed={showingTrash}
          onClick={onTrashClick}
        >
          <Trash2Icon className="size-3.5 shrink-0" aria-hidden="true" />
          Trash
        </button>
      </XpPane>

      <XpPane title="Details">
        {single ? (
          <div className="xp-details">
            {single.type === "directory" ? (
              <XpFolderGlyph size={32} />
            ) : (
              <XpFileGlyph size={32} color={xpFileMarkColor(single.name)} />
            )}
            <div className="xp-details-text">
              <div className="xp-details-name">{single.name}</div>
              <div className="xp-details-meta">{xpTypeLabel(single)}</div>
              {single.type === "file" && single.size !== undefined && (
                <div className="xp-details-meta">{formatXpSize(single.size)}</div>
              )}
            </div>
          </div>
        ) : selected.length > 1 ? (
          <div className="xp-details-meta">{selected.length} objects selected</div>
        ) : (
          <div className="xp-details">
            <XpFolderGlyph size={32} />
            <div className="xp-details-text">
              <div className="xp-details-name">
                {currentPath ? currentPath.split("/").pop() : "Home"}
              </div>
              <div className="xp-details-meta">File Folder</div>
            </div>
          </div>
        )}
      </XpPane>
    </aside>
  );
}

function XpPane({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="xp-pane">
      <button
        type="button"
        className="xp-pane-header"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{title}</span>
        <XpChevronGlyph className="xp-chevron" direction={open ? "up" : "down"} />
      </button>
      {open && <div className="xp-pane-body">{children}</div>}
    </section>
  );
}
