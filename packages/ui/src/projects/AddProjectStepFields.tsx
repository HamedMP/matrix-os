// Presentational per-mode steps for the add-project dialog. State and submit
// orchestration live in AddProjectForm; these components only render fields
// and forward edits. Each OS view injects its own Button and folder picker.
import type { ComponentType, CSSProperties, ReactNode } from "react";
import { projectForFolderPath, resolveProjectFolderChoice, type AddProjectRecord, type FolderPickerChoice } from "./add-project-model.js";

export interface AddProjectButtonProps {
  variant: "primary" | "subtle";
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}

/** A directories-only browser of the Matrix computer, supplied by each OS view. */
export interface AddProjectFolderPickerProps {
  onChooseFolder(path: string): void;
  onCreateFolder?(path: string): void;
  resolveFolderChoice?(path: string): FolderPickerChoice;
  onAlternateFolderAction?(path: string): void;
}

export const FIELD_STYLE: CSSProperties = {
  background: "var(--bg-raised)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius)",
  padding: "8px 10px",
  fontSize: "var(--text-sm, 0.875rem)",
  width: "100%",
  outline: "none",
};
export const DANGER_TEXT = "var(--danger-text, var(--destructive))";

export function CloneStepFields({
  url, onUrlChange, onUrlBlur, showUrlError, folderName, onFolderNameChange, showFolderNameError,
  branch, onBranchChange, onBranchBlur, showBranchError, submitting,
}: {
  url: string;
  onUrlChange: (value: string) => void;
  onUrlBlur: () => void;
  showUrlError: boolean;
  folderName: string;
  onFolderNameChange: (value: string) => void;
  showFolderNameError: boolean;
  branch: string;
  onBranchChange: (value: string) => void;
  onBranchBlur: () => void;
  showBranchError: boolean;
  submitting: boolean;
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Repository URL</span>
        <input
          autoFocus
          value={url}
          disabled={submitting}
          onChange={(e) => onUrlChange(e.target.value)}
          onBlur={onUrlBlur}
          placeholder="https://github.com/owner/repo"
          style={FIELD_STYLE}
        />
      </label>
      {showUrlError ? (
        <span className="text-xs" style={{ color: DANGER_TEXT }}>
          Enter a GitHub URL like https://github.com/owner/repo.
        </span>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Folder name</span>
        <input
          value={folderName}
          disabled={submitting}
          onChange={(e) => onFolderNameChange(e.target.value)}
          placeholder="Folder name"
          style={FIELD_STYLE}
        />
      </label>
      {showFolderNameError ? (
        <span className="text-xs" style={{ color: DANGER_TEXT }}>
          Use lowercase letters, numbers, and dashes only.
        </span>
      ) : null}
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Branch (optional)</span>
        <input
          value={branch}
          disabled={submitting}
          onChange={(e) => onBranchChange(e.target.value)}
          onBlur={onBranchBlur}
          placeholder="Default branch"
          style={FIELD_STYLE}
        />
      </label>
      {showBranchError ? (
        <span className="text-xs" style={{ color: DANGER_TEXT }}>That branch name isn't valid.</span>
      ) : null}
      {submitting ? (
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          Cloning the repository. Large repos can take a few minutes.
        </span>
      ) : null}
    </>
  );
}

export function ExistingFolderStepFields({
  name, onNameChange, folderPath, projects, FolderPicker, onChooseFolder, onCreateFolder, onOpenProject, submitting,
}: {
  name: string;
  onNameChange: (value: string) => void;
  folderPath: string;
  projects: readonly AddProjectRecord[];
  FolderPicker: ComponentType<AddProjectFolderPickerProps>;
  onChooseFolder: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onOpenProject: (slug: string) => void;
  submitting: boolean;
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Name</span>
        <input
          autoFocus
          value={name}
          disabled={submitting}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Project name"
          style={FIELD_STYLE}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Choose a folder on this computer</span>
        <FolderPicker
          onChooseFolder={onChooseFolder}
          onCreateFolder={onCreateFolder}
          resolveFolderChoice={(path) => resolveProjectFolderChoice(projects, path)}
          onAlternateFolderAction={(path) => {
            const project = projectForFolderPath(projects, path);
            if (project) onOpenProject(project.slug);
          }}
        />
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          {folderPath ? `Selected: ${folderPath}` : "Select a folder. It stays in place and remains yours."}
        </span>
      </div>
    </>
  );
}

export function NewFolderStepFields({
  name, onNameChange, parentPath, parentPickerOpen, onOpenParentPicker, onChooseParent, onResetParent, submitting, Button, FolderPicker,
}: {
  name: string;
  onNameChange: (value: string) => void;
  parentPath: string;
  parentPickerOpen: boolean;
  onOpenParentPicker: () => void;
  onChooseParent: (path: string) => void;
  onResetParent: () => void;
  submitting: boolean;
  Button: ComponentType<AddProjectButtonProps>;
  FolderPicker: ComponentType<AddProjectFolderPickerProps>;
}) {
  return (
    <>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Name</span>
        <input
          autoFocus
          value={name}
          disabled={submitting}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Project name"
          style={FIELD_STYLE}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Location</span>
        {parentPath ? (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <span className="min-w-0 truncate text-xs" style={{ color: "var(--text-secondary)" }} title={parentPath}>
              Create in: {parentPath}
            </span>
            <Button variant="subtle" disabled={submitting} onClick={onResetParent}>
              Use Projects instead
            </Button>
          </div>
        ) : parentPickerOpen ? (
          <FolderPicker onChooseFolder={onChooseParent} />
        ) : (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
            style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
          >
            <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Projects (default)</span>
            <Button variant="subtle" disabled={submitting} onClick={onOpenParentPicker}>
              Choose a different folder…
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
