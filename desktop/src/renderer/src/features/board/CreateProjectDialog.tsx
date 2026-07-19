import { ArrowLeft, FolderOpen, FolderPlus, Github } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { CloneStepFields, ExistingFolderStepFields, NewFolderStepFields } from "./AddProjectStepFields";
import { submitClone, submitExistingFolder, submitNewFolder } from "./add-project-submit";
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
    const isCurrent = () => !dialogClosedRef.current && dialogGenerationRef.current === submitGeneration;
    const ctx = {
      api,
      runtimeSlot,
      createProject,
      selectProject,
      loadProjects,
      openTab,
      isCurrent,
      setError,
      close: closeFromUser,
    };
    try {
      if (step === "folder") {
        await submitExistingFolder(ctx, { name: name.trim(), path: folderPath });
      } else if (step === "github") {
        await submitClone(ctx, { url: url.trim(), name: effectiveFolderName, branch: trimmedBranch || undefined });
      } else {
        await submitNewFolder(ctx, { name: name.trim(), parentPath });
      }
    } catch (err: unknown) {
      if (isCurrent()) setError(toUserMessage(err));
    } finally {
      if (isCurrent()) setSubmitting(false);
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
          onChooseFolder={chooseFolder}
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
    <Dialog open={open} onClose={onClose} width={620}>
      <CreateProjectForm onClose={onClose} />
    </Dialog>
  );
}
