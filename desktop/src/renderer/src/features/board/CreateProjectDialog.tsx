import { FolderOpen, FolderPlus, Github } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import ComputerFileBrowser from "../files/ComputerFileBrowser";

type Mode = "scratch" | "folder" | "github";

// Inner form mounts only while open, so its state is fresh per open (no
// reset-on-prop effect). autoFocus replaces a focus setTimeout.
function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const api = useConnection((s) => s.api);
  const createProject = useBoard((s) => s.createProject);
  const selectProject = useBoard((s) => s.selectProject);
  const openTab = useTabs((s) => s.openTab);
  const runtimeSlot = useConnection((s) => s.runtimeSlot);
  const authGeneration = useConnection((s) => s.authGeneration);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("scratch");
  const [url, setUrl] = useState("");
  // A folder chosen under one computer/session must not stay submittable under
  // another, so the selection carries its scope and resolves to "" as soon as
  // the slot or credential generation changes (synchronously, like the Files
  // workspace selection).
  const [folderSelection, setFolderSelection] = useState<{ slot: string; authGeneration: number; path: string } | null>(null);
  const path = folderSelection && folderSelection.slot === runtimeSlot && folderSelection.authGeneration === authGeneration
    ? folderSelection.path
    : "";
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogClosedRef = useRef(false);
  const dialogGenerationRef = useRef(0);

  useEffect(() => {
    setFolderSelection((current) =>
      current && (current.slot !== runtimeSlot || current.authGeneration !== authGeneration)
        ? null
        : current,
    );
  }, [authGeneration, runtimeSlot]);

  const chooseFolder = useCallback(
    (chosen: string) => setFolderSelection({ slot: runtimeSlot, authGeneration, path: chosen }),
    [authGeneration, runtimeSlot],
  );

  const canSubmit = name.trim().length > 0 && (
    mode === "scratch" ||
    (mode === "folder" && path.trim().length > 0) ||
    (mode === "github" && url.trim().length > 0)
  );

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

  const submit = async () => {
    if (!api || !canSubmit || submitting) return;
    const submitGeneration = dialogGenerationRef.current;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject(api, {
        name: name.trim(),
        mode,
        ...(mode === "github" ? { url: url.trim() } : {}),
        ...(mode === "folder" ? { path: path.trim() } : {}),
      });
      if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
      if (!project) {
        setError(
          mode === "github"
            ? "Couldn't create the project. Check the name and GitHub URL."
            : mode === "folder"
              ? "Couldn't connect that folder. Check that it exists on this computer."
              : "Couldn't create the project. Check the name.",
        );
        return;
      }
      await selectProject(api, project.slug);
      if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
      closeFromUser();
      openTab({ kind: "project", projectSlug: project.slug, title: project.name || project.slug });
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

  const field: React.CSSProperties = {
    background: "var(--bg-raised)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius)",
    padding: "8px 10px",
    fontSize: "var(--text-sm)",
    width: "100%",
    outline: "none",
  };

  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <span className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>Create project</span>

      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" style={field} />
      </label>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>How do you want to start?</span>
        <div className="flex rounded-lg border p-0.5" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
          {([
            { key: "scratch" as const, label: "New folder", icon: <FolderPlus size={13} /> },
            { key: "folder" as const, label: "Use existing folder", icon: <FolderOpen size={13} /> },
            { key: "github" as const, label: "Clone GitHub", icon: <Github size={13} /> },
          ]).map((opt) => {
            const activeMode = mode === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setMode(opt.key)}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-100"
                style={{ background: activeMode ? "var(--bg-surface)" : "transparent", color: activeMode ? "var(--text-primary)" : "var(--text-secondary)", boxShadow: activeMode ? "var(--shadow-1)" : "none" }}
              >
                {opt.icon}
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {mode === "github" ? (
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>GitHub repository URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo" style={field} />
        </label>
      ) : mode === "folder" ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>Choose a folder on this computer</span>
          <ComputerFileBrowser compact onChooseFolder={chooseFolder} />
          <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
            {path ? `Selected: ${path}` : "Select a folder. It stays in place and remains yours."}
          </span>
        </div>
      ) : (
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          A new project folder is created on your Matrix computer. Git and GitHub are optional.
        </p>
      )}

      {error ? <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="subtle" onClick={closeFromUser}>Cancel</Button>
        <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void submit()}>
          {submitting ? "Creating…" : "Create"}
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
