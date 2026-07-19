import { ArrowLeft, FolderOpen, FolderPlus, Github } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { AppError, toUserMessage } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import ComputerFileBrowser from "../files/ComputerFileBrowser";
import { cloneProject } from "./clone-project";
import {
  isValidBranchName,
  isValidProjectSlug,
  parseGitHubHttpsUrl,
  slugifyProjectName,
} from "./add-project-model";

type Mode = "folder" | "github" | "scratch";
type Step = "pick" | Mode;

// A folder chosen under one computer/session must not stay submittable under
// another, so every selection carries its scope and resolves to "" as soon as
// the slot or credential generation changes (synchronously, like the Files
// workspace selection).
interface ScopedPath {
  slot: string;
  authGeneration: number;
  path: string;
}

function scopedPath(selection: ScopedPath | null, slot: string, authGeneration: number): string {
  return selection && selection.slot === slot && selection.authGeneration === authGeneration
    ? selection.path
    : "";
}

const FIELD_STYLE: React.CSSProperties = {
  background: "var(--bg-raised)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius)",
  padding: "8px 10px",
  fontSize: "var(--text-sm)",
  width: "100%",
  outline: "none",
};

function ModeCard({
  icon,
  label,
  description,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-colors duration-100 hover:bg-[var(--bg-hover)]"
      style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
    >
      <span style={{ color: "var(--accent)" }}>{icon}</span>
      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</span>
      <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{description}</span>
    </button>
  );
}

// Inner form mounts only while open, so its state is fresh per open (no
// reset-on-prop effect). autoFocus replaces a focus setTimeout.
function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const api = useConnection((s) => s.api);
  const createProject = useBoard((s) => s.createProject);
  const selectProject = useBoard((s) => s.selectProject);
  const loadProjects = useBoard((s) => s.loadProjects);
  const openTab = useTabs((s) => s.openTab);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const authGeneration = useConnection((s) => s.authGeneration);

  const [step, setStep] = useState<Step>("pick");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [url, setUrl] = useState("");
  const [urlAttempted, setUrlAttempted] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderNameTouched, setFolderNameTouched] = useState(false);
  const [branch, setBranch] = useState("");
  const [branchAttempted, setBranchAttempted] = useState(false);
  const [folderSelection, setFolderSelection] = useState<ScopedPath | null>(null);
  const [parentSelection, setParentSelection] = useState<ScopedPath | null>(null);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogClosedRef = useRef(false);
  const dialogGenerationRef = useRef(0);

  const folderPath = scopedPath(folderSelection, runtimeSlot, authGeneration);
  const parentPath = scopedPath(parentSelection, runtimeSlot, authGeneration);

  const parsedUrl = parseGitHubHttpsUrl(url);
  const derivedFolderName = parsedUrl ? slugifyProjectName(parsedUrl.repo) : "";
  const effectiveFolderName = folderNameTouched ? folderName : derivedFolderName;
  const trimmedBranch = branch.trim();
  const urlInvalid = url.trim().length > 0 && !parsedUrl;
  const branchInvalid = trimmedBranch.length > 0 && !isValidBranchName(trimmedBranch);

  useEffect(() => {
    setFolderSelection((current) =>
      current && (current.slot !== runtimeSlot || current.authGeneration !== authGeneration)
        ? null
        : current,
    );
    setParentSelection((current) =>
      current && (current.slot !== runtimeSlot || current.authGeneration !== authGeneration)
        ? null
        : current,
    );
  }, [authGeneration, runtimeSlot]);

  useEffect(() => {
    dialogGenerationRef.current += 1;
    dialogClosedRef.current = false;
    return () => {
      dialogGenerationRef.current += 1;
      dialogClosedRef.current = true;
    };
  }, []);

  const closeFromUser = useCallback(() => {
    dialogGenerationRef.current += 1;
    dialogClosedRef.current = true;
    onClose();
  }, [onClose]);

  const chooseFolder = useCallback(
    (chosen: string) => setFolderSelection({ slot: runtimeSlot, authGeneration, path: chosen }),
    [authGeneration, runtimeSlot],
  );

  // Auto-fill the project name from the chosen folder until the user edits it.
  useEffect(() => {
    if (!nameTouched && folderPath) {
      setName(folderPath.split("/").pop() ?? "");
    }
  }, [folderPath, nameTouched]);

  const chooseParent = useCallback(
    (chosen: string) => {
      setParentSelection({ slot: runtimeSlot, authGeneration, path: chosen });
      setParentPickerOpen(false);
    },
    [authGeneration, runtimeSlot],
  );

  const canSubmit = (() => {
    if (step === "folder") return name.trim().length > 0 && folderPath.length > 0;
    if (step === "github") {
      // Non-empty gates only; format errors surface inline on submit.
      return url.trim().length > 0 && effectiveFolderName.length > 0;
    }
    if (step === "scratch") {
      return name.trim().length > 0;
    }
    return false;
  })();

  // Shared success path for every mode: make the new project active and open
  // its project tab, same as the previous single-mode dialog.
  const finish = async (project: { slug: string; name: string }, submitGeneration: number) => {
    if (!api) return;
    await selectProject(api, project.slug);
    if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
    closeFromUser();
    openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug });
  };

  const submit = async () => {
    if (!api || step === "pick" || !canSubmit || submitting) return;
    if (step === "github") {
      setUrlAttempted(true);
      setBranchAttempted(true);
      if (!parsedUrl || branchInvalid || !isValidProjectSlug(effectiveFolderName)) return;
    }
    if (step === "scratch" && slugifyProjectName(name.trim()).length === 0) {
      setError("Use at least one letter or number in the name.");
      return;
    }
    const submitGeneration = dialogGenerationRef.current;
    setSubmitting(true);
    setError(null);
    try {
      if (step === "folder") {
        const project = await createProject(api, { name: name.trim(), mode: "folder", path: folderPath });
        if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
        if (!project) {
          setError("Couldn't connect that folder. Check that it exists on this computer.");
          return;
        }
        await finish(project, submitGeneration);
        return;
      }
      if (step === "github") {
        const result = await cloneProject({
          baseUrl: api.baseUrl,
          runtimeSlot,
          url: url.trim(),
          name: effectiveFolderName,
          branch: trimmedBranch || undefined,
        });
        if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
        if (!result.ok) {
          setError(result.message);
          return;
        }
        // The board store only refreshes on its own create path, so pull the
        // new clone into the sidebar list explicitly.
        await loadProjects(api);
        if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
        await finish(result.project, submitGeneration);
        return;
      }
      // scratch: a new folder in the projects root, or under a chosen parent
      // via the mkdir route followed by a folder bind.
      const slug = slugifyProjectName(name.trim());
      if (!parentPath) {
        const project = await createProject(api, { name: name.trim(), mode: "scratch" });
        if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
        if (!project) {
          setError("Couldn't create the project. Check the name.");
          return;
        }
        await finish(project, submitGeneration);
        return;
      }
      let createdPath: string;
      try {
        const created = await api.post<{ path?: unknown }>("/api/projects/mkdir", { name: slug, parent: parentPath });
        if (typeof created.path !== "string" || created.path.length === 0) {
          setError("Couldn't create the folder. Try again.");
          return;
        }
        createdPath = created.path;
      } catch (err: unknown) {
        if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
        setError(
          err instanceof AppError && err.detail === "folder_conflict"
            ? "A folder with that name already exists there."
            : toUserMessage(err),
        );
        return;
      }
      if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
      const project = await createProject(api, { name: name.trim(), mode: "folder", path: createdPath });
      if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
      if (!project) {
        setError("The folder was created but couldn't be connected. Add it with “Existing folder”.");
        return;
      }
      await finish(project, submitGeneration);
    } catch (err: unknown) {
      if (!dialogClosedRef.current && dialogGenerationRef.current === submitGeneration) {
        setError(toUserMessage(err));
      }
    } finally {
      if (!dialogClosedRef.current && dialogGenerationRef.current === submitGeneration) {
        setSubmitting(false);
      }
    }
  };

  const submitLabel = step === "github" ? (submitting ? "Cloning…" : "Clone") : submitting ? "Creating…" : "Create";
  const stepTitle = step === "folder"
    ? "Connect an existing folder"
    : step === "github"
      ? "Clone from GitHub"
      : "New folder";

  return step === "pick" ? (
    <div className="flex flex-col gap-3 p-4">
      <span className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Add project</span>
      <div className="grid grid-cols-3 gap-2">
        <ModeCard
          icon={<FolderOpen size={16} />}
          label="Existing folder"
          description="Connect a folder already on this computer"
          onSelect={() => setStep("folder")}
        />
        <ModeCard
          icon={<Github size={16} />}
          label="Clone from GitHub"
          description="Copy a repository to this computer"
          onSelect={() => setStep("github")}
        />
        <ModeCard
          icon={<FolderPlus size={16} />}
          label="New folder"
          description="Start empty in a fresh folder"
          onSelect={() => setStep("scratch")}
        />
      </div>
      <div className="flex justify-end pt-1">
        <Button variant="subtle" onClick={closeFromUser}>Cancel</Button>
      </div>
    </div>
  ) : (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Back"
          onClick={() => {
            setStep("pick");
            setError(null);
          }}
          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-tertiary)" }}
        >
          <ArrowLeft size={14} />
        </button>
        <span className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{stepTitle}</span>
      </div>

      {step === "github" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Repository URL</span>
            <input
              autoFocus
              value={url}
              disabled={submitting}
              onChange={(e) => setUrl(e.target.value)}
              onBlur={() => setUrlAttempted(true)}
              placeholder="https://github.com/owner/repo"
              style={FIELD_STYLE}
            />
          </label>
          {(urlAttempted || url.length > 0) && urlInvalid ? (
            <span className="text-xs" style={{ color: "var(--danger)" }}>
              Enter a GitHub URL like https://github.com/owner/repo.
            </span>
          ) : null}
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Folder name</span>
            <input
              value={effectiveFolderName}
              disabled={submitting}
              onChange={(e) => {
                setFolderName(e.target.value);
                setFolderNameTouched(true);
              }}
              placeholder="Folder name"
              style={FIELD_STYLE}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Branch (optional)</span>
            <input
              value={branch}
              disabled={submitting}
              onChange={(e) => setBranch(e.target.value)}
              onBlur={() => setBranchAttempted(true)}
              placeholder="Default branch"
              style={FIELD_STYLE}
            />
          </label>
          {branchAttempted && branchInvalid ? (
            <span className="text-xs" style={{ color: "var(--danger)" }}>That branch name isn't valid.</span>
          ) : null}
          {submitting ? (
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              Cloning the repository. Large repos can take a few minutes.
            </span>
          ) : null}
        </>
      ) : null}

      {step === "folder" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Name</span>
            <input
              autoFocus
              value={name}
              disabled={submitting}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              placeholder="Project name"
              style={FIELD_STYLE}
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Choose a folder on this computer</span>
            <ComputerFileBrowser compact mode="folder-picker" onChooseFolder={chooseFolder} />
            <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
              {folderPath ? `Selected: ${folderPath}` : "Select a folder. It stays in place and remains yours."}
            </span>
          </div>
        </>
      ) : null}

      {step === "scratch" ? (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Name</span>
            <input
              autoFocus
              value={name}
              disabled={submitting}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
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
                <Button variant="subtle" disabled={submitting} onClick={() => setParentSelection(null)}>
                  Use Projects instead
                </Button>
              </div>
            ) : parentPickerOpen ? (
              <ComputerFileBrowser compact mode="folder-picker" onChooseFolder={chooseParent} />
            ) : (
              <div
                className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                style={{ borderColor: "var(--border-subtle)", background: "var(--bg-surface)" }}
              >
                <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Projects (default)</span>
                <Button variant="subtle" disabled={submitting} onClick={() => setParentPickerOpen(true)}>
                  Choose a different folder…
                </Button>
              </div>
            )}
          </div>
        </>
      ) : null}

      {error ? <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="subtle" onClick={closeFromUser}>Cancel</Button>
        <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export default function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} width={620}>
      <CreateProjectForm onClose={onClose} />
    </Dialog>
  );
}
