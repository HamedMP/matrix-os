import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import { Button, Dialog } from "../../design/primitives";
import { useBoard, BOARD_COLUMNS, type CardPriority, type CardStatus } from "../../stores/board";
import { useConnection } from "../../stores/connection";
import { useTabs } from "../../stores/tabs";
import { useUi } from "../../stores/ui";

const PRIORITIES: CardPriority[] = ["low", "normal", "high", "urgent"];
const SELECT_STYLE: CSSProperties = {
  background: "var(--bg-raised)",
  color: "var(--text-primary)",
  border: "1px solid var(--border-default)",
  borderRadius: "var(--radius)",
  padding: "4px 8px",
  fontSize: "var(--text-sm)",
};

// Default the new task to the column its "+" was clicked from (set in the UI
// store when opening), falling back to "todo".
function initialStatus(): CardStatus {
  const fromColumn = useUi.getState().createTaskStatus;
  return fromColumn && (BOARD_COLUMNS as readonly string[]).includes(fromColumn)
    ? (fromColumn as CardStatus)
    : "todo";
}

// Inner form is mounted only while the dialog is open, so its state starts
// fresh on each open without a reset-on-prop effect (react-doctor: no
// state-synced-to-prop). autoFocus replaces a focus setTimeout.
function CreateTaskForm({
  onClose,
  dialogClosedRef,
  dialogGenerationRef,
}: {
  onClose: () => void;
  dialogClosedRef: MutableRefObject<boolean>;
  dialogGenerationRef: MutableRefObject<number>;
}) {
  const api = useConnection((s) => s.api);
  const activeSlug = useBoard((s) => s.activeProjectSlug);
  const createTask = useBoard((s) => s.createTask);
  const openTab = useTabs((s) => s.openTab);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<CardStatus>(initialStatus);
  const [priority, setPriority] = useState<CardPriority>("normal");
  const [submitting, setSubmitting] = useState(false);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const unavailableMessage = !activeSlug
    ? "Select a project before creating a task."
    : !api
      ? "Connect to Matrix OS before creating a task."
      : null;
  const canSubmit = !unavailableMessage && !submitting && title.trim().length > 0;

  const closeFromUser = useCallback(() => {
    dialogGenerationRef.current += 1;
    dialogClosedRef.current = true;
    onClose();
  }, [dialogClosedRef, dialogGenerationRef, onClose]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closeFromUser();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closeFromUser]);

  const logSubmitFailure = useCallback((err: unknown) => {
    console.warn("[create-task] failed to submit task:", err instanceof Error ? err.message : String(err));
  }, []);

  const submit = async (openAfter: boolean) => {
    if (title.trim().length === 0 || submitting) return;
    if (!api || !activeSlug) {
      setFailureMessage(unavailableMessage ?? "Couldn't create the task. Please try again.");
      return;
    }
    const submitGeneration = dialogGenerationRef.current;
    setSubmitting(true);
    setFailureMessage(null);
    let card: Awaited<ReturnType<typeof createTask>>;
    try {
      card = await createTask(api, activeSlug, {
        title: title.trim(),
        description: description.trim() || undefined,
        status,
        priority,
      });
    } catch (err: unknown) {
      logSubmitFailure(err);
      if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
      setSubmitting(false);
      setFailureMessage("Couldn't create the task. Please try again.");
      return;
    }
    if (dialogClosedRef.current || dialogGenerationRef.current !== submitGeneration) return;
    setSubmitting(false);
    if (!card) {
      setFailureMessage("Couldn't create the task. Please try again.");
      return;
    }
    onClose();
    if (openAfter) openTab({ kind: "task", taskId: card.id, projectSlug: card.projectSlug, title: card.title });
  };

  return (
    <form
      className="flex flex-col gap-3 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false).catch(logSubmitFailure);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void submit(e.shiftKey).catch(logSubmitFailure);
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
        <select
          aria-label="Task status"
          value={status}
          onChange={(e) => setStatus(e.target.value as CardStatus)}
          style={SELECT_STYLE}
        >
          {BOARD_COLUMNS.map((s) => (
            <option key={s} value={s}>
              {s[0]?.toUpperCase()}
              {s.slice(1)}
            </option>
          ))}
        </select>
        <select
          aria-label="Task priority"
          value={priority}
          onChange={(e) => setPriority(e.target.value as CardPriority)}
          style={SELECT_STYLE}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p[0]?.toUpperCase()}
              {p.slice(1)}
            </option>
          ))}
        </select>
      </div>
      {unavailableMessage || failureMessage ? (
        <p className="text-sm" style={{ color: "var(--danger)" }}>
          {unavailableMessage ?? failureMessage}
        </p>
      ) : null}
      <div
        className="flex items-center justify-end gap-2 border-t pt-3"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <Button variant="ghost" onClick={closeFromUser}>
          Cancel
        </Button>
        <Button
          variant="subtle"
          disabled={!canSubmit}
          onClick={() => void submit(true).catch(logSubmitFailure)}
          title="Create and open (Cmd+Shift+Enter)"
        >
          Create + open
        </Button>
        <Button
          variant="primary"
          disabled={!canSubmit}
          onClick={() => void submit(false).catch(logSubmitFailure)}
          title="Create (Cmd+Enter)"
        >
          {submitting ? "Creating…" : "Create"}
        </Button>
      </div>
    </form>
  );
}

export default function CreateTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const dialogClosedRef = useRef(!open);
  const dialogGenerationRef = useRef(0);

  useEffect(() => {
    dialogGenerationRef.current += 1;
    dialogClosedRef.current = !open;
    return () => {
      dialogGenerationRef.current += 1;
      dialogClosedRef.current = true;
    };
  }, [open]);

  const closeFromUser = useCallback(() => {
    dialogGenerationRef.current += 1;
    dialogClosedRef.current = true;
    onClose();
  }, [onClose]);

  return (
    <Dialog open={open} onClose={closeFromUser} width={520}>
      {open ? (
        <CreateTaskForm
          onClose={closeFromUser}
          dialogClosedRef={dialogClosedRef}
          dialogGenerationRef={dialogGenerationRef}
        />
      ) : null}
    </Dialog>
  );
}
