import { useEffect, useRef, useState } from "react";
import { Card, type ViewProps } from "./common";
export default function Focus(props: ViewProps) {
  const sessionId = useRef<string | null>(null);
  const [minutes, setMinutes] = useState(25),
    [task, setTask] = useState(""),
    [deadline, setDeadline] = useState<number | null>(null),
    [remaining, setRemaining] = useState(25 * 60),
    [completed, setCompleted] = useState(false),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  useEffect(() => {
    if (deadline === null) return;
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setRemaining(left);
      if (left === 0) {
        setDeadline(null);
        setCompleted(true);
      }
    };
    tick();
    const timer = setInterval(tick, 500);
    return () => clearInterval(timer);
  }, [deadline]);
  async function log() {
    if (!completed || !task.trim() || saving) return;
    setSaving(true);
    try {
      const d = new Date(),
        date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      await props.onSave({
        id: sessionId.current ?? (sessionId.current = crypto.randomUUID()),
        fields: { title: task.trim(), date, minutes, notes: null },
        scope: props.app.collection === "business" ? "work" : "personal",
        accounts: [],
        sources: [],
        manualFields: ["title", "date", "minutes"],
        updatedAt: d.toISOString(),
      });
      setCompleted(false);
      sessionId.current = null;
      setTask("");
      setError("");
      setRemaining(minutes * 60);
    } catch (cause) {
      console.error("Focus session save failed", cause);
      setError("Session could not be saved. Keep it here and try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="focus-stage">
        <span className="eyebrow">One thing at a time</span>
        <input
          aria-label="Focus task"
          disabled={saving}
          value={task}
          maxLength={1000}
          onChange={(e) => setTask(e.target.value)}
          placeholder="What deserves your attention?"
        />
        <div
          className="timer"
          role="timer"
          aria-label={`${Math.floor(remaining / 60)} minutes ${remaining % 60} seconds remaining`}
        >
          {String(Math.floor(remaining / 60)).padStart(2, "0")}
          <span>:</span>
          {String(remaining % 60).padStart(2, "0")}
        </div>
        <label>
          Session{" "}
          <select
            value={minutes}
            disabled={deadline !== null || completed}
            onChange={(e) => {
              setMinutes(Number(e.target.value));
              setRemaining(Number(e.target.value) * 60);
            }}
          >
            {[5, 15, 25, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>
        <div>
          {completed ? (
            <button
              className="primary"
              disabled={!task.trim() || saving}
              onClick={() => void log()}
            >
              {saving ? "Saving…" : "Log completed session"}
            </button>
          ) : deadline !== null ? (
            <button
              onClick={() => {
                setDeadline(null);
                setRemaining(minutes * 60);
              }}
            >
              Stop session
            </button>
          ) : (
            <button
              className="primary"
              disabled={!task.trim()}
              onClick={() => setDeadline(Date.now() + remaining * 1000)}
            >
              Begin focus
            </button>
          )}
        </div>
        <p className="muted">Sessions count only after you save them.</p>
        {error && (
          <p role="alert" className="notice error">
            {error}
          </p>
        )}
      </div>
      <div className="section-heading">
        <h3>Saved sessions</h3>
        <span>
          {props.records.reduce(
            (sum, r) =>
              sum +
              (typeof r.fields.minutes === "number" ? r.fields.minutes : 0),
            0,
          )}{" "}
          minutes recorded
        </span>
      </div>
      <div className="card-grid">
        {props.records.map((record) => (
          <Card key={record.id} record={record} {...props} />
        ))}
      </div>
    </>
  );
}
