import { ArrowLeft, FolderOpen, FolderPlus, Github, X } from "@renderer/lib/hugeicons";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { CloneStepFields, ExistingFolderStepFields, NewFolderStepFields } from "./AddProjectStepFields";
import {
  openExistingProject,
  submitClone,
  submitExistingFolder,
  submitNewFolder,
  type AddProjectSubmitContext,
} from "./add-project-submit";
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

function ModeCard({
  icon,
  label,
  description,
  selected,
  onSelect,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="flex min-h-[86px] flex-col items-center justify-center gap-1 rounded-lg border p-3 text-center outline-none transition-colors duration-100 hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ borderColor: selected ? "var(--text-primary)" : "var(--border-subtle)", background: selected ? "var(--bg-selected)" : "var(--bg-surface)" }}
    >
      <span style={{ color: "var(--text-primary)" }}>{icon}</span>
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
  const projects = useBoard((s) => s.projects);
  const openTab = useTabs((s) => s.openTab);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const authGeneration = useConnection((s) => s.authGeneration);

  const [step, setStep] = useState<Step>("pick");
  const [selectedMode, setSelectedMode] = useState<Mode | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [urlAttempted, setUrlAttempted] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderNameTouched, setFolderNameTouched] = useState(false);
  const [branch, setBranch] = useState("");
  const [branchAttempted, setBranchAttempted] = useState(false);
  const [folderSelection, setFolderSelection] = useState<ScopedPath | null>(null);
  const [parentSelection, setParentSelection] = useState<ScopedPath | null>(null);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [activeSubmission, setActiveSubmission] = useState<{
    runtimeSlot: string;
    authGeneration: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cloneRequestId] = useState(() => `req_${crypto.randomUUID()}`);
  const folderRequestRef = useRef<{ payload: string; id: string } | null>(null);
  const dialogClosedRef = useRef(false);
  const dialogGenerationRef = useRef(0);
  // Latest runtime identity. A submission captures the identity it was sent to
  // and compares against this when it settles: loadProjects/selectProject use
  // the API client's CURRENT runtime, so completing a request issued to a
  // previous computer would open a project that does not exist on the one the
  // user is now looking at.
  const runtimeIdentityRef = useRef({ runtimeSlot, authGeneration });
  useEffect(() => {
    runtimeIdentityRef.current = { runtimeSlot, authGeneration };
  }, [authGeneration, runtimeSlot]);

  const folderPath = scopedPath(folderSelection, runtimeSlot, authGeneration);
  const parentPath = scopedPath(parentSelection, runtimeSlot, authGeneration);

  const parsedUrl = parseGitHubHttpsUrl(url);
  const derivedFolderName = parsedUrl ? slugifyProjectName(parsedUrl.repo) : "";
  const effectiveFolderName = folderNameTouched ? folderName : derivedFolderName;
  const trimmedBranch = branch.trim();
  const urlInvalid = url.trim().length > 0 && !parsedUrl;
  const branchInvalid = trimmedBranch.length > 0 && !isValidBranchName(trimmedBranch);
  const folderNameInvalid = effectiveFolderName.length > 0 && !isValidProjectSlug(effectiveFolderName);
  // A request sent to another computer remains in flight, but it must not keep
  // this computer's dialog disabled while its stale completion is ignored.
  const submitting = activeSubmission?.runtimeSlot === runtimeSlot
    && activeSubmission.authGeneration === authGeneration;

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

  const startNewFolderAt = useCallback(
    (chosen: string) => {
      setName("");
      setNameTouched(false);
      setFolderSelection(null);
      setParentSelection({ slot: runtimeSlot, authGeneration, path: chosen });
      setParentPickerOpen(false);
      setError(null);
      setStep("scratch");
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

  const beginSubmission = (): { ctx: AddProjectSubmitContext; isCurrent: () => boolean } | null => {
    if (!api || submitting) return null;
    const submitGeneration = dialogGenerationRef.current;
    const submitRuntimeSlot = runtimeSlot;
    const submitAuthGeneration = authGeneration;
    setActiveSubmission({ runtimeSlot: submitRuntimeSlot, authGeneration: submitAuthGeneration });
    setError(null);
    const isCurrent = () =>
      !dialogClosedRef.current
      && dialogGenerationRef.current === submitGeneration
      && runtimeIdentityRef.current.runtimeSlot === submitRuntimeSlot
      && runtimeIdentityRef.current.authGeneration === submitAuthGeneration;
    return {
      isCurrent,
      ctx: {
        api,
        runtimeSlot,
        getProjects: () => useBoard.getState().projects,
        createProject,
        selectProject,
        loadProjects,
        openTab,
        isCurrent,
        setError,
        close: closeFromUser,
      },
    };
  };

  const runSubmission = async (action: (ctx: AddProjectSubmitContext) => Promise<void>) => {
    const submission = beginSubmission();
    if (!submission) return;
    try {
      await action(submission.ctx);
    } catch (err: unknown) {
      if (submission.isCurrent()) setError(toUserMessage(err));
    } finally {
      if (submission.isCurrent()) setActiveSubmission(null);
    }
  };

  const submit = async () => {
    if (step === "pick" || !canSubmit || submitting) return;
    if (step === "github") {
      setUrlAttempted(true);
      setBranchAttempted(true);
      if (!parsedUrl || branchInvalid || !isValidProjectSlug(effectiveFolderName)) return;
    }
    if (step === "scratch" && slugifyProjectName(name.trim()).length === 0) {
      setError("Use at least one letter or number in the name.");
      return;
    }
    await runSubmission(async (ctx) => {
      if (step === "folder") {
        await submitExistingFolder(ctx, { name: name.trim(), description: description.trim() || undefined, path: folderPath });
      } else if (step === "github") {
        await submitClone(ctx, {
          url: url.trim(),
          name: effectiveFolderName,
          displayName: name.trim(),
          description: description.trim() || undefined,
          branch: trimmedBranch || undefined,
          clientRequestId: cloneRequestId,
        });
      } else {
        const folderPayload = JSON.stringify({ name: name.trim(), parentPath });
        if (folderRequestRef.current?.payload !== folderPayload) {
          folderRequestRef.current = {
            payload: folderPayload,
            id: `req_desktop_folder_${crypto.randomUUID()}`,
          };
        }
        await submitNewFolder(ctx, {
          name: name.trim(),
          description: description.trim() || undefined,
          parentPath,
          clientRequestId: folderRequestRef.current.id,
        });
      }
    });
  };

  const submitLabel = step === "github" ? (submitting ? "Cloning…" : "Clone") : submitting ? "Creating…" : "Create";
  const stepTitle = step === "folder"
    ? "Connect an existing folder"
    : step === "github"
      ? "Clone from GitHub"
      : "New folder";

  return step === "pick" ? (
    <div className="flex flex-col">
      <div className="flex h-12 items-center border-b px-4" style={{ borderColor: "var(--border-subtle)" }}>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Create a project</h2>
        <button
          type="button"
          aria-label="Close create project"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={closeFromUser}
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <label className="flex flex-col gap-1.5 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          What are you working on?
          <input
            autoFocus
            aria-label="What are you working on?"
            value={name}
            maxLength={128}
            onChange={(event) => {
              setName(event.target.value);
              setNameTouched(true);
            }}
            placeholder="Name your project"
            className="h-8 rounded-md border bg-transparent px-2.5 text-sm outline-none focus:border-[var(--accent)]"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          What are you trying to achieve?
          <textarea
            aria-label="What are you trying to achieve?"
            value={description}
            maxLength={1_000}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe your project, goals, subject, etc…"
            className="min-h-[72px] resize-none rounded-md border bg-transparent px-2.5 py-2 text-sm font-normal outline-none focus:border-[var(--accent)]"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <ModeCard
            icon={<FolderOpen size={16} />}
            label="Existing folder"
            description="Connect a folder on this computer"
            selected={selectedMode === "folder"}
            onSelect={() => {
              setSelectedMode("folder");
              setStep("folder");
            }}
          />
          <ModeCard
            icon={<Github size={16} />}
            label="Clone from GitHub"
            description="Copy a repository to this computer"
            selected={selectedMode === "github"}
            onSelect={() => {
              setSelectedMode("github");
              setStep("github");
            }}
          />
          <ModeCard
            icon={<FolderPlus size={16} />}
            label="New folder"
            description="Create a local project"
            selected={selectedMode === "scratch"}
            onSelect={() => {
              setSelectedMode("scratch");
              setParentSelection(null);
              setStep("scratch");
            }}
          />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>
        <Button variant="subtle" onClick={closeFromUser}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!name.trim() || selectedMode === null}
          onClick={() => {
            if (!name.trim() || !selectedMode) return;
            setStep(selectedMode);
          }}
        >
          Create project
        </Button>
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
          disabled={submitting}
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
        <CloneStepFields
          url={url}
          onUrlChange={setUrl}
          onUrlBlur={() => setUrlAttempted(true)}
          showUrlError={(urlAttempted || url.length > 0) && urlInvalid}
          folderName={effectiveFolderName}
          onFolderNameChange={(value) => {
            setFolderName(value);
            setFolderNameTouched(true);
          }}
          showFolderNameError={folderNameTouched && folderNameInvalid}
          branch={branch}
          onBranchChange={setBranch}
          onBranchBlur={() => setBranchAttempted(true)}
          showBranchError={branchAttempted && branchInvalid}
          submitting={submitting}
        />
      ) : null}

      {step === "folder" ? (
        <ExistingFolderStepFields
          name={name}
          onNameChange={(value) => {
            setName(value);
            setNameTouched(true);
          }}
          folderPath={folderPath}
          projects={projects}
          onChooseFolder={chooseFolder}
          onCreateFolder={startNewFolderAt}
          onOpenProject={(slug) => void runSubmission((ctx) => openExistingProject(ctx, slug))}
          submitting={submitting}
        />
      ) : null}

      {step === "scratch" ? (
        <NewFolderStepFields
          name={name}
          onNameChange={(value) => {
            setName(value);
            setNameTouched(true);
          }}
          parentPath={parentPath}
          parentPickerOpen={parentPickerOpen}
          onOpenParentPicker={() => setParentPickerOpen(true)}
          onChooseParent={chooseParent}
          onResetParent={() => setParentSelection(null)}
          submitting={submitting}
        />
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
    <Dialog open={open} onClose={onClose} width={480} title="Create a project" placement="center">
      <CreateProjectForm onClose={onClose} />
    </Dialog>
  );
}
