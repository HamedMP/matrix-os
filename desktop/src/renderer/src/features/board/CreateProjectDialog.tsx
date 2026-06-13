import { FolderPlus, Github } from "lucide-react";
import { useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { toUserMessage } from "../../lib/errors";
import { useBoard } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

type Mode = "scratch" | "github";

// Inner form mounts only while open, so its state is fresh per open (no
// reset-on-prop effect). autoFocus replaces a focus setTimeout.
function CreateProjectForm({ onClose }: { onClose: () => void }) {
  const api = useConnection((s) => s.api);
  const createProject = useBoard((s) => s.createProject);
  const selectProject = useBoard((s) => s.selectProject);
  const openTab = useTabs((s) => s.openTab);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<Mode>("scratch");
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && (mode === "scratch" || url.trim().length > 0);

  const submit = async () => {
    if (!api || !canSubmit || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const project = await createProject(api, {
        name: name.trim(),
        mode,
        ...(mode === "github" ? { url: url.trim() } : {}),
      });
      if (!project) {
        setError("Couldn't create the project. Check the name" + (mode === "github" ? " and the GitHub URL." : "."));
        return;
      }
      void selectProject(api, project.slug);
      onClose();
      openTab({ kind: "board", projectSlug: project.slug, title: project.name || project.slug });
    } catch (err: unknown) {
      setError(toUserMessage(err));
    } finally {
      setSubmitting(false);
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
            { key: "scratch" as const, label: "Start from scratch", icon: <FolderPlus size={13} /> },
            { key: "github" as const, label: "Import from GitHub", icon: <Github size={13} /> },
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
      ) : (
        <p className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          A fresh repository is created on your cloud computer. Connect it to GitHub later from the board.
        </p>
      )}

      {error ? <span className="text-xs" style={{ color: "var(--danger)" }}>{error}</span> : null}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="subtle" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSubmit || submitting} onClick={() => void submit()}>
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}

export default function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} width={520}>
      <CreateProjectForm onClose={onClose} />
    </Dialog>
  );
}
