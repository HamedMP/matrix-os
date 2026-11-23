// The add-project dialog body shared by Electron Desktop and the web OS views.
// Each OS view wraps it in its own dialog chrome and supplies a Button, a
// folder picker of the Matrix computer, and a submit context for its transport.
import { ArrowLeft, FolderOpen, FolderPlus, Github, X } from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { isValidBranchName, isValidProjectSlug, parseGitHubHttpsUrl, slugifyProjectName, type AddProjectRecord } from "./add-project-model.js";
import { openExistingProject, submitClone, submitExistingFolder, submitNewFolder, type AddProjectSubmitContext } from "./add-project-submit.js";
import { DANGER_TEXT } from "./add-project-styles.js";
import {
  CloneStepFields, ExistingFolderStepFields, NewFolderStepFields,
  type AddProjectButtonProps, type AddProjectFolderPickerProps,
} from "./AddProjectStepFields.js";

type Mode = "folder" | "github" | "scratch";
type Step = "pick" | Mode;
export type ProjectShareAvailability = "loading" | "none" | "member" | "unavailable";

// A folder chosen under one computer/session must not stay submittable under
// another, so every selection carries its scope and resolves to "" as soon as
// the scope changes (synchronously, like the Files workspace selection).
interface ScopedPath { scope: string; path: string }
function scopedPath(selection: ScopedPath | null, scope: string): string {
  return selection && selection.scope === scope ? selection.path : "";
}

// Non-empty gates only; format errors surface inline on submit.
function stepCanSubmit(step: Step, fields: { name: string; folderPath: string; url: string; folderName: string }): boolean {
  if (step === "folder") return fields.name.trim().length > 0 && fields.folderPath.length > 0;
  if (step === "github") return fields.url.trim().length > 0 && fields.folderName.length > 0;
  if (step === "scratch") return fields.name.trim().length > 0;
  return false;
}

function stepCopy(step: Step, submitting: boolean): { submitLabel: string; stepTitle: string } {
  return {
    submitLabel: step === "github" ? (submitting ? "Cloning…" : "Clone") : submitting ? "Creating…" : "Create",
    stepTitle: step === "folder" ? "Connect an existing folder" : step === "github" ? "Clone from GitHub" : "New folder",
  };
}

type StepValues = {
  name: string; description?: string; folderPath: string; url: string; folderName: string; branch?: string;
  cloneRequestId: string; parentPath: string; folderRequestId: string;
};

function submitStep<P extends AddProjectRecord>(ctx: AddProjectSubmitContext<P>, step: Mode, values: StepValues): Promise<void> {
  if (step === "folder") return submitExistingFolder(ctx, { name: values.name, description: values.description, path: values.folderPath });
  if (step === "github") {
    return submitClone(ctx, {
      url: values.url, name: values.folderName, displayName: values.name, description: values.description,
      branch: values.branch, clientRequestId: values.cloneRequestId,
    });
  }
  return submitNewFolder(ctx, { name: values.name, description: values.description, parentPath: values.parentPath, clientRequestId: values.folderRequestId });
}

/** Clone step fields: the folder name follows the repository until edited; format errors show after an attempt. */
function useCloneFields() {
  const [url, setUrl] = useState("");
  const [urlAttempted, setUrlAttempted] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderNameTouched, setFolderNameTouched] = useState(false);
  const [branch, setBranch] = useState("");
  const [branchAttempted, setBranchAttempted] = useState(false);
  const parsedUrl = parseGitHubHttpsUrl(url);
  const effectiveFolderName = folderNameTouched ? folderName : parsedUrl ? slugifyProjectName(parsedUrl.repo) : "";
  const trimmedBranch = branch.trim();
  const urlInvalid = url.trim().length > 0 && !parsedUrl;
  const branchInvalid = trimmedBranch.length > 0 && !isValidBranchName(trimmedBranch);
  const folderNameInvalid = effectiveFolderName.length > 0 && !isValidProjectSlug(effectiveFolderName);
  return {
    url,
    branch,
    folderName: effectiveFolderName,
    attemptSubmit: () => {
      setUrlAttempted(true);
      setBranchAttempted(true);
      return Boolean(parsedUrl) && !branchInvalid && isValidProjectSlug(effectiveFolderName);
    },
    fieldProps: {
      url,
      onUrlChange: setUrl,
      onUrlBlur: () => setUrlAttempted(true),
      showUrlError: (urlAttempted || url.length > 0) && urlInvalid,
      folderName: effectiveFolderName,
      onFolderNameChange: (value: string) => {
        setFolderName(value);
        setFolderNameTouched(true);
      },
      showFolderNameError: folderNameTouched && folderNameInvalid,
      branch,
      onBranchChange: setBranch,
      onBranchBlur: () => setBranchAttempted(true),
      showBranchError: branchAttempted && branchInvalid,
    },
  };
}

function Icon({ icon }: { icon: IconSvgElement }) {
  return <HugeiconsIcon icon={icon} size={16} strokeWidth={1.5} />;
}

function ModeCard({ icon, label, description, selected, onSelect }: {
  icon: IconSvgElement; label: string; description: string; selected: boolean; onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="flex min-h-[86px] flex-col items-center justify-center gap-1 rounded-lg border p-3 text-center outline-none transition-colors duration-100 hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
      style={{ borderColor: selected ? "var(--text-primary)" : "var(--border-subtle)", background: selected ? "var(--bg-selected, var(--bg-hover))" : "var(--bg-surface)" }}
    >
      <span style={{ color: "var(--text-primary)" }}><Icon icon={icon} /></span>
      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</span>
      <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{description}</span>
    </button>
  );
}

function AddProjectPickStep({ name, description, selectedMode, Button, onClose, onNameChange, onDescriptionChange, onSelectMode, onContinue }: {
  name: string; description: string; selectedMode: Mode | null; Button: ComponentType<AddProjectButtonProps>; onClose(): void;
  onNameChange(value: string): void; onDescriptionChange(value: string): void; onSelectMode(mode: Mode): void; onContinue(): void;
}) {
  return (
    <div className="flex flex-col">
      <div className="flex h-12 items-center border-b px-4" style={{ borderColor: "var(--border-subtle)" }}>
        <h2 className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Create a project</h2>
        <button
          type="button"
          aria-label="Close create project"
          className="ml-auto flex h-7 w-7 items-center justify-center rounded-md hover:bg-[var(--bg-hover)]"
          style={{ color: "var(--text-tertiary)" }}
          onClick={onClose}
        >
          <HugeiconsIcon icon={X} size={14} strokeWidth={1.5} />
        </button>
      </div>
      <div className="flex flex-col gap-4 p-4">
        <label className="flex flex-col gap-1.5 text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
          What are you working on?
          <input
            // react-doctor-disable-next-line react-doctor/no-autofocus -- the dialog opens only from an explicit Create project action; the name field takes focus as in Electron Desktop
            autoFocus
            aria-label="What are you working on?"
            value={name}
            maxLength={128}
            onChange={(event) => onNameChange(event.target.value)}
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
            onChange={(event) => onDescriptionChange(event.target.value)}
            placeholder="Describe your project, goals, subject, etc…"
            className="min-h-[72px] resize-none rounded-md border bg-transparent px-2.5 py-2 text-sm font-normal outline-none focus:border-[var(--accent)]"
            style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
          />
        </label>
        <div className="grid grid-cols-3 gap-2">
          <ModeCard icon={FolderOpen} label="Existing folder" description="Connect a folder on this computer"
            selected={selectedMode === "folder"} onSelect={() => onSelectMode("folder")} />
          <ModeCard icon={Github} label="Clone from GitHub" description="Copy a repository to this computer"
            selected={selectedMode === "github"} onSelect={() => onSelectMode("github")} />
          <ModeCard icon={FolderPlus} label="New folder" description="Create a local project"
            selected={selectedMode === "scratch"} onSelect={() => onSelectMode("scratch")} />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: "var(--border-subtle)" }}>
        <Button variant="subtle" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!name.trim() || selectedMode === null} onClick={onContinue}>Create project</Button>
      </div>
    </div>
  );
}

function ShareAfterCreatingOption({ availability, checked, disabled, onChange }: {
  availability: Exclude<ProjectShareAvailability, "none">; checked: boolean; disabled: boolean; onChange(checked: boolean): void;
}) {
  const hint = availability === "member"
    ? "Choose organization members after creation. The entire project is shared."
    : availability === "loading" ? "Checking organization access…" : "Sharing is temporarily unavailable.";
  return <label className="flex items-start gap-2 rounded-lg border px-3 py-2" style={{ borderColor: "var(--border-subtle)" }}>
    <input
      type="checkbox"
      aria-label="Share project after creating"
      checked={checked}
      disabled={disabled || availability !== "member"}
      onChange={(event) => onChange(event.target.checked)}
      className="mt-0.5"
    />
    <span className="flex flex-col gap-0.5">
      <span className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>Share project after creating</span>
      <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>{hint}</span>
    </span>
  </label>;
}

export interface AddProjectFormProps<P extends AddProjectRecord> {
  /** Runtime identity (computer + credentials). A change invalidates selections and in-flight submits. */
  scope: string;
  projects: readonly P[];
  Button: ComponentType<AddProjectButtonProps>;
  FolderPicker: ComponentType<AddProjectFolderPickerProps>;
  /** Null while the OS view cannot reach the computer. */
  createContext(base: Pick<AddProjectSubmitContext<P>, "isCurrent" | "setError" | "close"> & { shareRequested: boolean }): AddProjectSubmitContext<P> | null;
  /** Safe copy for an unexpected submit failure. */
  toErrorMessage(error: unknown): string;
  onClose(): void;
  shareAvailability?: ProjectShareAvailability;
  /** Prefix for new-folder idempotency keys; the gateway requires `req_`. */
  folderRequestPrefix: `req_${string}`;
}

/** Runs one submit at a time; a closed dialog or a computer switch makes its completion a no-op. */
function useAddProjectSubmission<P extends AddProjectRecord>({ scope, onClose, toErrorMessage, createContext }: {
  scope: string;
  onClose(): void;
  toErrorMessage(error: unknown): string;
  createContext(base: Pick<AddProjectSubmitContext<P>, "isCurrent" | "setError" | "close">): AddProjectSubmitContext<P> | null;
}) {
  const [activeSubmission, setActiveSubmission] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogClosedRef = useRef(false);
  const dialogGenerationRef = useRef(0);
  // Latest runtime identity. A submission captures the scope it was sent to
  // and compares against this when it settles: completing a request issued to
  // a previous computer would open a project that does not exist on the one
  // the user is now looking at.
  const scopeRef = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  useEffect(() => {
    dialogGenerationRef.current += 1;
    dialogClosedRef.current = false;
    return () => {
      dialogGenerationRef.current += 1;
      dialogClosedRef.current = true;
    };
  }, []);
  // A request sent to another computer remains in flight, but it must not keep
  // this computer's dialog disabled while its stale completion is ignored.
  const submitting = activeSubmission === scope;

  const closeFromUser = useCallback(() => {
    dialogGenerationRef.current += 1;
    dialogClosedRef.current = true;
    onClose();
  }, [onClose]);

  const runSubmission = async (action: (ctx: AddProjectSubmitContext<P>) => Promise<void>) => {
    if (submitting) return;
    const submitGeneration = dialogGenerationRef.current;
    const submitScope = scope;
    const isCurrent = () => !dialogClosedRef.current
      && dialogGenerationRef.current === submitGeneration
      && scopeRef.current === submitScope;
    const ctx = createContext({ isCurrent, setError, close: closeFromUser });
    if (!ctx) return;
    setActiveSubmission(submitScope);
    setError(null);
    try {
      await action(ctx);
    } catch (err: unknown) {
      if (isCurrent()) setError(toErrorMessage(err));
    } finally {
      if (isCurrent()) setActiveSubmission(null);
    }
  };
  return { submitting, error, setError, closeFromUser, runSubmission };
}

// Mounts only while open, so its state is fresh per open (no reset-on-prop effect).
export function AddProjectForm<P extends AddProjectRecord>({
  scope, projects, Button, FolderPicker, createContext, toErrorMessage, onClose, shareAvailability = "none", folderRequestPrefix,
}: AddProjectFormProps<P>) {
  const [step, setStep] = useState<Step>("pick");
  const [selectedMode, setSelectedMode] = useState<Mode | null>(null);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState("");
  const clone = useCloneFields();
  const [folderSelection, setFolderSelection] = useState<ScopedPath | null>(null);
  const [parentSelection, setParentSelection] = useState<ScopedPath | null>(null);
  const [parentPickerOpen, setParentPickerOpen] = useState(false);
  const [shareAfterCreating, setShareAfterCreating] = useState(false);
  const [cloneRequestId] = useState(() => `req_${crypto.randomUUID()}`);
  const folderRequestRef = useRef<{ payload: string; id: string } | null>(null);
  const { submitting, error, setError, closeFromUser, runSubmission } = useAddProjectSubmission({
    scope, onClose, toErrorMessage,
    createContext: (base) => createContext({ ...base, shareRequested: shareAfterCreating && shareAvailability === "member" }),
  });

  const folderPath = scopedPath(folderSelection, scope);
  const parentPath = scopedPath(parentSelection, scope);

  const chooseFolder = useCallback((chosen: string) => setFolderSelection({ scope, path: chosen }), [scope]);

  // Auto-fill the project name from the chosen folder until the user edits it.
  useEffect(() => {
    if (!nameTouched && folderPath) setName(folderPath.split("/").pop() ?? "");
  }, [folderPath, nameTouched]);

  const chooseParent = useCallback((chosen: string) => {
    setParentSelection({ scope, path: chosen });
    setParentPickerOpen(false);
  }, [scope]);

  const startNewFolderAt = useCallback((chosen: string) => {
    setName("");
    setNameTouched(false);
    setFolderSelection(null);
    setParentSelection({ scope, path: chosen });
    setParentPickerOpen(false);
    setError(null);
    setStep("scratch");
  }, [scope, setError]);

  const canSubmit = stepCanSubmit(step, { name, folderPath, url: clone.url, folderName: clone.folderName });

  const submit = async () => {
    if (step === "pick" || !canSubmit || submitting) return;
    if (step === "github" && !clone.attemptSubmit()) return;
    if (step === "scratch" && slugifyProjectName(name.trim()).length === 0) {
      setError("Use at least one letter or number in the name.");
      return;
    }
    const folderPayload = JSON.stringify({ name: name.trim(), parentPath });
    if (step === "scratch" && folderRequestRef.current?.payload !== folderPayload) {
      folderRequestRef.current = { payload: folderPayload, id: `${folderRequestPrefix}${crypto.randomUUID()}` };
    }
    const values = {
      name: name.trim(), description: description.trim() || undefined, folderPath, url: clone.url.trim(), folderName: clone.folderName,
      branch: clone.branch.trim() || undefined, cloneRequestId, parentPath, folderRequestId: folderRequestRef.current?.id ?? "",
    };
    await runSubmission((ctx) => submitStep(ctx, step, values));
  };

  const { submitLabel, stepTitle } = stepCopy(step, submitting);

  return step === "pick" ? (
    <AddProjectPickStep name={name} description={description} selectedMode={selectedMode} Button={Button} onClose={closeFromUser}
      onNameChange={(value) => { setName(value); setNameTouched(true); }} onDescriptionChange={setDescription}
      onSelectMode={(mode) => { setSelectedMode(mode); if (mode === "scratch") setParentSelection(null); setStep(mode); }}
      onContinue={() => { if (name.trim() && selectedMode) setStep(selectedMode); }} />
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
          <HugeiconsIcon icon={ArrowLeft} size={14} strokeWidth={1.5} />
        </button>
        <span className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>{stepTitle}</span>
      </div>

      {step === "github" ? (
        <CloneStepFields
          {...clone.fieldProps}
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
          FolderPicker={FolderPicker}
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
          Button={Button}
          FolderPicker={FolderPicker}
        />
      ) : null}

      {error ? <span role="alert" className="text-xs" style={{ color: DANGER_TEXT }}>{error}</span> : null}

      {shareAvailability !== "none" ? <ShareAfterCreatingOption availability={shareAvailability} checked={shareAfterCreating}
        disabled={submitting} onChange={setShareAfterCreating} /> : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="subtle" onClick={closeFromUser}>Cancel</Button>
        <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void submit()}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
