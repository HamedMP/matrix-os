import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  CalendarClock,
  CalendarDays,
  Check,
  Flag,
  Folder,
  Inbox,
  Plus,
  Repeat,
  Trash2,
} from "lucide-react";
import "./styles.css";
import {
  countByView,
  filterTasks,
  nextRecurrence,
  normalizeTask,
  projectNames,
  sortTasks,
  type Recurrence,
  type Task,
  type View,
} from "./todo-model";

const TASKS_TABLE = "tasks";
const NOTES_SAVE_DELAY_MS = 500;

type SmartViewId = "inbox" | "today" | "upcoming";

const PRIORITY_LABELS = ["No flag", "Low", "Medium", "High"] as const;
const RECUR_OPTIONS: { value: Recurrence | ""; label: string }[] = [
  { value: "", label: "No repeat" },
  { value: "daily", label: "Daily" },
  { value: "weekdays", label: "Weekdays" },
  { value: "weekly", label: "Weekly" },
];

interface SmartViewMeta {
  id: SmartViewId;
  label: string;
  icon: typeof Inbox;
  empty: { title: string; body: string };
}

const SMART_VIEWS: SmartViewMeta[] = [
  {
    id: "inbox",
    label: "Inbox",
    icon: Inbox,
    empty: {
      title: "Your inbox is clear",
      body: "Capture anything on your mind. Type a task above and press Enter.",
    },
  },
  {
    id: "today",
    label: "Today",
    icon: CalendarDays,
    empty: {
      title: "Nothing due today",
      body: "Tasks scheduled for today or overdue show up here. Enjoy the calm.",
    },
  },
  {
    id: "upcoming",
    label: "Upcoming",
    icon: CalendarClock,
    empty: {
      title: "No upcoming plans",
      body: "Give a task a future due date and it will land here.",
    },
  },
];

// --- DB helpers (guarded, typed try/catch by caller) -----------------------

function getDb(): NonNullable<Window["MatrixOS"]>["db"] | undefined {
  return typeof window !== "undefined" ? window.MatrixOS?.db : undefined;
}

async function loadTasks(): Promise<Task[]> {
  const db = getDb();
  if (!db) return [];
  const rows = await db.find(TASKS_TABLE, { orderBy: { created_at: "desc" } });
  return rows
    .map(normalizeTask)
    .filter((t): t is Task => t !== null);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- formatting -------------------------------------------------------------

function toDateInputValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fromDateInputValue(value: string): string | null {
  if (!value) return null;
  const d = new Date(`${value}T09:00:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatDue(iso: string | null, now: Date): { label: string; tone: "overdue" | "today" | "soon" | "later" } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const diff = Math.floor((new Date(d).setHours(0, 0, 0, 0) - start.getTime()) / day);
  if (diff < 0) return { label: diff === -1 ? "Yesterday" : `${Math.abs(diff)}d overdue`, tone: "overdue" };
  if (diff === 0) return { label: "Today", tone: "today" };
  if (diff === 1) return { label: "Tomorrow", tone: "soon" };
  if (diff < 7) return { label: d.toLocaleDateString(undefined, { weekday: "long" }), tone: "soon" };
  return { label: d.toLocaleDateString(undefined, { month: "short", day: "numeric" }), tone: "later" };
}

// --- component --------------------------------------------------------------

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<View>("inbox");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [now, setNow] = useState(() => new Date());
  const inFlightComplete = useRef<Set<string>>(new Set());
  const listRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      setTasks(await loadTasks());
    } catch (err: unknown) {
      console.warn("[todo] task load failed:", errMessage(err));
      setError("Tasks could not be loaded. They may be out of date.");
    }
  }, []);

  useEffect(() => {
    void reload();
    const db = getDb();
    if (!db?.onChange) return undefined;
    return db.onChange(TASKS_TABLE, () => void reload());
  }, [reload]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const counts = useMemo(() => countByView(tasks, now), [tasks, now]);
  const projects = useMemo(() => projectNames(tasks), [tasks]);

  const projectCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tasks) {
      if (t.status === "open" && t.project) map.set(t.project, (map.get(t.project) ?? 0) + 1);
    }
    return map;
  }, [tasks]);

  const visible = useMemo(() => sortTasks(filterTasks(tasks, view, now)), [tasks, view, now]);
  const selectedTask = useMemo(
    () => (selectedId ? visible.find((t) => t.id === selectedId) ?? null : null),
    [selectedId, visible],
  );

  const activeSmart: SmartViewMeta | null =
    typeof view === "string" ? SMART_VIEWS.find((v) => v.id === view) ?? null : null;
  const headerTitle = typeof view === "string" ? activeSmart?.label ?? "Tasks" : view.project;

  // --- mutations ------------------------------------------------------------

  const addTask = useCallback(async () => {
    const title = draft.trim();
    if (!title) return;
    const project = typeof view === "object" ? view.project : null;
    const optimistic: Task = {
      id: `local-${Date.now()}`,
      title,
      notes: "",
      due: view === "today" ? now.toISOString() : null,
      priority: 0,
      project,
      status: "open",
      recur: null,
      created_at: new Date().toISOString(),
    };
    setTasks((cur) => [optimistic, ...cur]);
    setDraft("");
    const db = getDb();
    if (!db) return;
    try {
      await db.insert(TASKS_TABLE, {
        title,
        notes: "",
        due: optimistic.due,
        priority: 0,
        project,
        status: "open",
        recur: null,
      });
      await reload();
    } catch (err: unknown) {
      console.warn("[todo] task insert failed:", errMessage(err));
      setError("Task could not be saved.");
      setTasks((cur) => cur.filter((t) => t.id !== optimistic.id));
    }
  }, [draft, view, now, reload]);

  const persistUpdate = useCallback(
    async (id: string, patch: Partial<Task>) => {
      setTasks((cur) => cur.map((t) => (t.id === id ? { ...t, ...patch } : t)));
      const db = getDb();
      if (!db) return;
      try {
        await db.update(TASKS_TABLE, id, patch as Record<string, unknown>);
      } catch (err: unknown) {
        console.warn("[todo] task update failed:", errMessage(err));
        setError("Change could not be saved.");
        await reload();
      }
    },
    [reload],
  );

  const patchSelectedTask = useCallback(
    (patch: Partial<Task>) => {
      if (selectedId) void persistUpdate(selectedId, patch);
    },
    [persistUpdate, selectedId],
  );

  const completeTask = useCallback(
    async (task: Task) => {
      if (inFlightComplete.current.has(task.id)) return;
      if (task.recur && !task.due) {
        setError("Add a due date before completing a repeating task.");
        setSelectedId(task.id);
        return;
      }
      inFlightComplete.current.add(task.id);
      // Optimistically mark done.
      setTasks((cur) => cur.map((t) => (t.id === task.id ? { ...t, status: "done" } : t)));
      const db = getDb();
      try {
        if (db) await db.update(TASKS_TABLE, task.id, { status: "done" });
        // Recurring task: schedule the next occurrence.
        const nextDue = task.due ? nextRecurrence(task.recur, new Date(task.due)) : null;
        if (task.recur && nextDue) {
          const followUp: Task = {
            ...task,
            id: `local-${Date.now()}`,
            due: nextDue,
            status: "open",
            created_at: new Date().toISOString(),
          };
          setTasks((cur) => [followUp, ...cur]);
          if (db) {
            await db.insert(TASKS_TABLE, {
              title: task.title,
              notes: task.notes,
              due: nextDue,
              priority: task.priority,
              project: task.project,
              status: "open",
              recur: task.recur,
            });
          }
        }
        if (db) await reload();
      } catch (err: unknown) {
        console.warn("[todo] task complete failed:", errMessage(err));
        setError("Could not complete task.");
        if (db) {
          try {
            await db.update(TASKS_TABLE, task.id, { status: "open" });
          } catch (rollbackErr: unknown) {
            console.warn("[todo] task completion rollback failed:", errMessage(rollbackErr));
          }
        }
        await reload();
      } finally {
        inFlightComplete.current.delete(task.id);
      }
    },
    [reload],
  );

  const deleteTask = useCallback(
    async (id: string) => {
      setTasks((cur) => cur.filter((t) => t.id !== id));
      if (selectedId === id) setSelectedId(null);
      const db = getDb();
      if (!db) return;
      try {
        await db.delete(TASKS_TABLE, id);
        await reload();
      } catch (err: unknown) {
        console.warn("[todo] task delete failed:", errMessage(err));
        setError("Task could not be deleted.");
        await reload();
      }
    },
    [reload, selectedId],
  );

  const cyclePriority = useCallback(
    (task: Task) => {
      const next = ((task.priority + 1) % 4) as Task["priority"];
      void persistUpdate(task.id, { priority: next });
    },
    [persistUpdate],
  );

  const commitEdit = useCallback(
    (task: Task) => {
      const title = editTitle.trim();
      setEditingId(null);
      if (title && title !== task.title) void persistUpdate(task.id, { title });
    },
    [editTitle, persistUpdate],
  );

  // --- keyboard navigation --------------------------------------------------

  const onListKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (editingId) return;
      if (visible.length === 0) return;
      const idx = visible.findIndex((t) => t.id === selectedId);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = visible[Math.min(visible.length - 1, idx < 0 ? 0 : idx + 1)];
        setSelectedId(next.id);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next = visible[Math.max(0, idx < 0 ? 0 : idx - 1)];
        setSelectedId(next.id);
      } else if ((e.key === " " || e.key === "Enter") && selectedId) {
        e.preventDefault();
        const task = visible.find((t) => t.id === selectedId);
        if (task) void completeTask(task);
      } else if (e.key === "Backspace" && (e.metaKey || e.ctrlKey) && selectedId) {
        e.preventDefault();
        void deleteTask(selectedId);
      }
    },
    [editingId, visible, selectedId, completeTask, deleteTask],
  );

  const onDraftKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void addTask();
      }
    },
    [addTask],
  );

  const isProjectView = typeof view === "object";

  return (
    <div className="todo-app">
      <aside className="sidebar" aria-label="Views">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Check size={16} strokeWidth={3} />
          </span>
          <span>Tasks</span>
        </div>

        <nav className="nav-group" aria-label="Smart lists">
          {SMART_VIEWS.map((v) => {
            const ViewIcon = v.icon;
            const active = view === v.id;
            const count = counts[v.id];
            return (
              <button
                key={v.id}
                type="button"
                className={active ? "nav-item nav-item--active" : "nav-item"}
                aria-current={active ? "page" : undefined}
                onClick={() => {
                  setView(v.id);
                  setSelectedId(null);
                }}
              >
                <ViewIcon size={17} />
                <span className="nav-label">{v.label}</span>
                {count > 0 && <span className="nav-count">{count}</span>}
              </button>
            );
          })}
        </nav>

        {projects.length > 0 && (
          <div className="nav-group">
            <p className="nav-heading">Projects</p>
            {projects.map((name) => {
              const active = isProjectView && (view as { project: string }).project === name;
              const count = projectCounts.get(name) ?? 0;
              return (
                <button
                  key={name}
                  type="button"
                  className={active ? "nav-item nav-item--active" : "nav-item"}
                  onClick={() => {
                    setView({ kind: "project", project: name });
                    setSelectedId(null);
                  }}
                >
                  <Folder size={17} />
                  <span className="nav-label">{name}</span>
                  {count > 0 && <span className="nav-count">{count}</span>}
                </button>
              );
            })}
          </div>
        )}
      </aside>

      <main className="content">
        <header className="content-head">
          <h1>{headerTitle}</h1>
          <p className="content-sub">
            {visible.length} {visible.length === 1 ? "task" : "tasks"}
          </p>
        </header>

        <div className="capture">
          <Plus size={18} className="capture-icon" aria-hidden="true" />
          <input
            className="capture-input"
            placeholder={
              isProjectView ? `Add a task to ${headerTitle}` : "Add a task, press Enter"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onDraftKeyDown}
            aria-label="New task"
          />
        </div>

        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}

        <div
          className="task-list"
          data-testid="task-list"
          role="list"
          tabIndex={0}
          ref={listRef}
          onKeyDown={onListKeyDown}
        >
          {visible.length === 0 ? (
            <EmptyState view={view} smart={activeSmart} />
          ) : (
            visible.map((task) => {
              const due = formatDue(task.due, now);
              const selected = task.id === selectedId;
              const editing = task.id === editingId;
              return (
                <div
                  key={task.id}
                  role="listitem"
                  className={selected ? "task-row task-row--selected" : "task-row"}
                  onClick={() => setSelectedId(task.id)}
                >
                  <button
                    type="button"
                    className={`check check--p${task.priority}`}
                    aria-label={`Complete ${task.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void completeTask(task);
                    }}
                  >
                    <Check size={14} strokeWidth={3} className="check-mark" />
                  </button>

                  <div className="task-main">
                    {editing ? (
                      <input
                        className="edit-input"
                        autoFocus
                        value={editTitle}
                        aria-label={`Edit ${task.title}`}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => commitEdit(task)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitEdit(task);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setEditingId(null);
                          }
                        }}
                      />
                    ) : (
                      <button
                        type="button"
                        className="task-title"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(task.id);
                          setEditingId(task.id);
                          setEditTitle(task.title);
                        }}
                      >
                        {task.title}
                      </button>
                    )}
                    {(due || task.recur || (isProjectView ? false : task.project)) && (
                      <div className="task-meta">
                        {due && <span className={`due due--${due.tone}`}>{due.label}</span>}
                        {task.recur && (
                          <span className="meta-chip">
                            <Repeat size={11} /> {task.recur}
                          </span>
                        )}
                        {!isProjectView && task.project && (
                          <span className="meta-chip">
                            <Folder size={11} /> {task.project}
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  <button
                    type="button"
                    className={task.priority > 0 ? `flag flag--p${task.priority}` : "flag"}
                    title={PRIORITY_LABELS[task.priority]}
                    aria-label={`Priority for ${task.title}: ${PRIORITY_LABELS[task.priority]}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      cyclePriority(task);
                    }}
                  >
                    <Flag size={14} />
                  </button>

                  <button
                    type="button"
                    className="row-delete"
                    aria-label={`Delete ${task.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void deleteTask(task.id);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {selectedId && (
          <Inspector
            task={selectedTask}
            onClose={() => setSelectedId(null)}
            onPatch={patchSelectedTask}
          />
        )}
      </main>
    </div>
  );
}

function EmptyState({ view, smart }: { view: View; smart: SmartViewMeta | null }) {
  const Icon = smart?.icon ?? Folder;
  const title =
    smart?.empty.title ?? (typeof view === "object" ? `No tasks in ${view.project}` : "All done");
  const body =
    smart?.empty.body ?? "Add a task above to start filling out this project.";
  return (
    <div className="empty-state">
      <span className="empty-icon" aria-hidden="true">
        <Icon size={26} />
      </span>
      <strong>{title}</strong>
      <p>{body}</p>
    </div>
  );
}

function Inspector({
  task,
  onClose,
  onPatch,
}: {
  task: Task | null;
  onClose: () => void;
  onPatch: (patch: Partial<Task>) => void;
}) {
  const [notesDraft, setNotesDraft] = useState(task?.notes ?? "");
  const [projectDraft, setProjectDraft] = useState(task?.project ?? "");

  useEffect(() => {
    setNotesDraft(task?.notes ?? "");
    setProjectDraft(task?.project ?? "");
  }, [task?.id]);

  useEffect(() => {
    if (!task?.id || notesDraft === task.notes) return undefined;
    const timer = window.setTimeout(() => {
      onPatch({ notes: notesDraft });
    }, NOTES_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [notesDraft, onPatch, task?.id, task?.notes]);

  useEffect(() => {
    if (!task?.id || projectDraft.trim() === (task.project ?? "")) return undefined;
    const timer = window.setTimeout(() => {
      onPatch({ project: projectDraft.trim() || null });
    }, NOTES_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [onPatch, projectDraft, task?.id, task?.project]);

  if (!task) return null;
  return (
    <div className="inspector" role="dialog" aria-label={`Details for ${task.title}`}>
      <div className="inspector-head">
        <strong>Details</strong>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Close details">
          ✕
        </button>
      </div>

      <label className="field">
        <span>Notes</span>
        <textarea
          value={notesDraft}
          placeholder="Add notes…"
          onChange={(e) => setNotesDraft(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Due date</span>
        <input
          type="date"
          value={toDateInputValue(task.due)}
          onChange={(e) => {
            const due = fromDateInputValue(e.target.value);
            onPatch(due ? { due } : { due: null, recur: null });
          }}
        />
      </label>

      <label className="field">
        <span>Project</span>
        <input
          type="text"
          value={projectDraft}
          placeholder="No project"
          onChange={(e) => setProjectDraft(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Repeat</span>
        <select
          value={task.due ? (task.recur ?? "") : ""}
          disabled={!task.due}
          onChange={(e) => onPatch({ recur: (e.target.value || null) as Recurrence | null })}
        >
          {RECUR_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        {!task.due && <span className="field-hint">Add a due date to repeat this task.</span>}
      </label>
    </div>
  );
}
