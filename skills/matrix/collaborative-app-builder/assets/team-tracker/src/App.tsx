import React, { useEffect, useRef, useState } from "react";
import "./style.css";

type Task = { id: string; title: string; done: boolean };
type Action = { action: string; table: string; [key: string]: unknown };
type Reply = { result: unknown; revision: string };
type Bridge = {
  participant: { actorId: string; displayName: string } | null;
  query(action: Action): Promise<Reply>;
  mutate(action: Action, expectedRevision: string): Promise<Reply>;
  onChange(listener: () => void): () => void;
};

export default function App() {
  const shared = (window as unknown as { MatrixOS?: { collaboration: Bridge } }).MatrixOS?.collaboration;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef("0");
  const mounted = useRef(false);
  const reading = useRef(0);
  const writing = useRef(false);
  const pending = useRef<{ action: Action; draft: string } | null>(null);

  async function refresh() {
    const generation = ++reading.current;
    try {
      if (!shared) throw new Error("Missing Matrix bridge");
      const response = await shared.query({ action: "find", table: "tasks", limit: 100, orderBy: { title: "asc" } });
      if (!Array.isArray(response.result) || !response.result.every((row: Task) =>
        row && typeof row.id === "string" && typeof row.title === "string" && typeof row.done === "boolean")
        || !/^\d+$/.test(response.revision)) throw new Error("Invalid task response");
      const attempt = pending.current;
      const data = attempt?.action.data as Partial<Task> | undefined;
      const recordId = data?.id ?? attempt?.action.id;
      // A row outside the first page must not be mistaken for a confirmed delete.
      const confirmation = attempt ? await shared.query({ action: "findOne", table: "tasks", id: recordId }) : null;
      if (!mounted.current || generation !== reading.current) return;
      const rows = response.result as Task[];
      revision.current = response.revision;
      setTasks(rows);
      setLoaded(true);
      // A reread can confirm an uncertain result; it must never resubmit it.
      if (attempt && pending.current === attempt) {
        const row = confirmation!.result as Task | null;
        const confirmed = attempt.action.action === "delete" ? row === null : row && data && row.id === recordId
          && Object.entries(data).every(([key, value]) => row[key as keyof Task] === value);
        if (confirmed) {
          pending.current = null;
          if (attempt.action.action === "insert") setDraft((current) => current === attempt.draft ? "" : current);
          setError("");
        }
      } else setError("");
    } catch (failure: unknown) {
      console.warn("[team-tracker] read unavailable", failure instanceof Error ? failure.name : "UnknownError");
      if (mounted.current && generation === reading.current) setError("Saved tasks are unavailable. Your draft is still here.");
    }
  }

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = shared?.onChange(() => { void refresh(); });
    return () => { mounted.current = false; reading.current += 1; unsubscribe?.(); };
  }, [shared]);

  async function save(action: Action) {
    if (!shared || !loaded || writing.current || pending.current) return;
    writing.current = true;
    pending.current = { action, draft };
    setBusy(true);
    try {
      if (action.action === "insert") {
        await shared.mutate({ action: "insert", table: "tasks", data: action.data }, revision.current);
      } else if (action.action === "update") {
        await shared.mutate({ action: "update", table: "tasks", id: action.id, data: action.data }, revision.current);
      } else {
        await shared.mutate({ action: "delete", table: "tasks", id: action.id }, revision.current);
      }
      if (!mounted.current) return;
      pending.current = null;
      if (action.action === "insert") setDraft((current) => current === draft ? "" : current);
      await refresh();
    } catch (failure: unknown) {
      console.warn("[team-tracker] write not confirmed", failure instanceof Error ? failure.name : "UnknownError");
      if (mounted.current) setError("Save not confirmed. Your input is retained. Use Matrix’s Retry when offered, then review saved records. Do not submit the change again. Discarding a local draft does not cancel an earlier write.");
    } finally {
      writing.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const blocked = busy || !loaded || !!pending.current;
  return <main>
    <header><p>ONE TEAM · ONE RECORD SET</p><h1>Team tracker</h1>
      <span>{shared?.participant?.displayName ?? "Your owner workspace"}</span></header>
    <form onSubmit={(event) => {
      event.preventDefault();
      const title = draft.trim();
      if (title && !blocked) {
        const id = crypto.randomUUID();
        void save({ action: "insert", table: "tasks", data: { id, title, done: false } });
      }
    }}>
      <label htmlFor="new-task">New task</label>
      <div className="composer"><input id="new-task" value={draft} maxLength={200}
        onChange={(event) => setDraft(event.target.value)} placeholder="What needs doing?" />
        <button disabled={blocked || !draft.trim()} type="submit">Add task</button></div>
    </form>
    {error ? <section role="alert"><p>{error}</p>
      <button onClick={() => { void refresh(); }}>Review saved records</button>
      {pending.current && !busy ? <button onClick={() => {
        pending.current = null; setDraft(""); setError(""); void refresh();
      }}>Discard local draft</button> : null}
    </section> : null}
    <ul aria-label="Saved tasks">{tasks.map((task) => <li key={task.id}>
      <label><input type="checkbox" aria-label={`Complete ${task.title}`} checked={task.done} disabled={blocked}
        onChange={() => { void save({ action: "update", table: "tasks", id: task.id, data: { done: !task.done } }); }} />
        <span className={task.done ? "done" : ""}>{task.title}</span></label>
      <button disabled={blocked} aria-label={`Delete ${task.title}`}
        onClick={() => { void save({ action: "delete", table: "tasks", id: task.id }); }}>Delete</button>
    </li>)}</ul>
    {!tasks.length && loaded ? <p>No saved tasks yet.</p> : null}
    <footer>Records stay on the owner’s Matrix. Sharing gives every current member of the selected organization full app access.</footer>
  </main>;
}
