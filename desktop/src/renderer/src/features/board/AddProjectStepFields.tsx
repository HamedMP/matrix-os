// Presentational per-mode steps for the add-project dialog. State and submit
// orchestration live in CreateProjectDialog; these components only render
// fields and forward edits.
import { Button } from "../../design/primitives";
import type { Project } from "../../stores/board";
import ComputerFileBrowser, { type FolderPickerChoice } from "../files/ComputerFileBrowser";

export const FIELD_STYLE: React.CSSProperties = {
  background: "var(--bg-raised)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius)",
  padding: "8px 10px",
  fontSize: "var(--text-sm)",
  width: "100%",
  outline: "none",
};

export function CloneStepFields({
  url,
  onUrlChange,
  onUrlBlur,
  showUrlError,
  folderName,
  onFolderNameChange,
  showFolderNameError,
  branch,
  onBranchChange,
  onBranchBlur,
  showBranchError,
  submitting,
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
        <span className="text-xs" style={{ color: "var(--danger)" }}>
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
        <span className="text-xs" style={{ color: "var(--danger)" }}>
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
        <span className="text-xs" style={{ color: "var(--danger)" }}>That branch name isn't valid.</span>
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
  name,
  onNameChange,
  folderPath,
  projects,
  onChooseFolder,
  onCreateFolder,
  onOpenProject,
  submitting,
}: {
  name: string;
  onNameChange: (value: string) => void;
  folderPath: string;
  projects: Project[];
  onChooseFolder: (path: string) => void;
  onCreateFolder: (path: string) => void;
  onOpenProject: (slug: string) => void;
  submitting: boolean;
}) {
  const normalizePath = (path: string) => path.replaceAll("\\", "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  const projectForPath = (path: string): Project | undefined => {
    const normalized = normalizePath(path);
    const exact = projects.find((project) => {
      const localPath = normalizePath(project.localPath ?? "");
      return localPath === normalized || localPath.endsWith(`/${normalized}`);
    });
    if (exact) return exact;

    // Compatibility only: before MAT-340, projects/<slug> held Matrix-owned
    // metadata while the real checkout lived below it. Keep the Open action
    // for those already-connected legacy projects during lazy migration.
    const segments = normalized.split("/");
    if (segments.length !== 2 || segments[0] !== "projects") return undefined;
    return projects.find((project) => {
      if (project.slug !== segments[1] || project.kind === "folder") return false;
      const localPath = normalizePath(project.localPath ?? "");
      return localPath === normalized
        || localPath.endsWith(`/${normalized}`)
        || localPath.includes(`/${normalized}/`);
    });
  };
  const resolveFolderChoice = (path: string): FolderPickerChoice => {
    const project = projectForPath(path);
    if (project) {
      return {
        kind: "alternate",
        label: `Open ${project.name}`,
        message: "This folder is already connected to Matrix OS.",
      };
    }
    // Matrix-owned project metadata now lives in system/projects. Every
    // ordinary owner folder is selectable here; the Gateway remains the
    // authority for protected paths and managed worktree boundaries.
    return { kind: "choose" };
  };

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
        <ComputerFileBrowser
          compact
          mode="folder-picker"
          onChooseFolder={onChooseFolder}
          onCreateFolder={onCreateFolder}
          resolveFolderChoice={resolveFolderChoice}
          onAlternateFolderAction={(path) => {
            const project = projectForPath(path);
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
  name,
  onNameChange,
  parentPath,
  parentPickerOpen,
  onOpenParentPicker,
  onChooseParent,
  onResetParent,
  submitting,
}: {
  name: string;
  onNameChange: (value: string) => void;
  parentPath: string;
  parentPickerOpen: boolean;
  onOpenParentPicker: () => void;
  onChooseParent: (path: string) => void;
  onResetParent: () => void;
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
          <ComputerFileBrowser compact mode="folder-picker" onChooseFolder={onChooseParent} />
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
