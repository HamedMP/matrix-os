import { useState } from "react";
import { Button, Dialog } from "../../design/primitives";
import { useBoard, BOARD_COLUMNS, type CardPriority, type CardStatus } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";

const PRIORITIES: CardPriority[] = ["low", "normal", "high", "urgent"];

// Inner form is mounted only while the dialog is open, so its state starts
// fresh on each open without a reset-on-prop effect (react-doctor: no
// state-synced-to-prop). autoFocus replaces a focus setTimeout.
function CreateTaskForm({ onClose }: { onClose: () => void }) {
  const api = useConnection((s) => s.api);
  const activeSlug = useBoard((s) => s.activeProjectSlug);
  const createTask = useBoard((s) => s.createTask);
  const openTab = useTabs((s) => s.openTab);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<CardStatus>("todo");
  const [priority, setPriority] = useState<CardPriority>("normal");
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (openAfter: boolean) => {
    if (!api || !activeSlug || title.trim().length === 0 || submitting) return;
    setSubmitting(true);
    setFailed(false);
    const card = await createTask(api, activeSlug, {
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority,
    });
    setSubmitting(false);
    if (!card) {
      setFailed(true);
      return;
    }
    onClose();
    if (openAfter) openTab({ kind: "task", taskId: card.id, projectSlug: card.projectSlug, title: card.title });
  };

  const selectStyle: React.CSSProperties = {
    background: "var(--bg-raised)",
    color: "var(--text-primary)",
    border: "1px solid var(--border-default)",
    borderRadius: "var(--radius)",
    padding: "4px 8px",
    fontSize: "var(--text-sm)",
  };

  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit(e.shiftKey);
        }
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        maxLength={200}
        className="w-full bg-transparent text-lg font-medium outline-none"
        style={{ color: "var(--text-primary)" }}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="Description (optional)"
        rows={3}
        className="w-full resize-none bg-transparent text-sm outline-none"
        style={{ color: "var(--text-secondary)" }}
      />
      <div className="flex items-center gap-2">
        <select value={status} onChange={(e) => setStatus(e.target.value as CardStatus)} style={selectStyle}>
          {BOARD_COLUMNS.map((s) => (
            <option key={s} value={s}>
              {s[0]?.toUpperCase()}
              {s.slice(1)}
            </option>
          ))}
        </select>
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as CardPriority)}
          style={selectStyle}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p[0]?.toUpperCase()}
              {p.slice(1)}
            </option>
          ))}
        </select>
      </div>
      {failed ? (
        <p className="text-sm" style={{ color: "var(--danger)" }}>
          Couldn't create the task. Please try again.
        </p>
      ) : null}
      <div
        className="flex items-center justify-end gap-2 border-t pt-3"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="subtle"
          disabled={submitting || title.trim().length === 0}
          onClick={() => void submit(true)}
          title="Create and open (Cmd+Shift+Enter)"
        >
          Create + open
        </Button>
        <Button
          variant="primary"
          disabled={submitting || title.trim().length === 0}
          onClick={() => void submit(false)}
          title="Create (Cmd+Enter)"
        >
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}

export default function CreateTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} width={520}>
      <CreateTaskForm onClose={onClose} />
    </Dialog>
  );
}
