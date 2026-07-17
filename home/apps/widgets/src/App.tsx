import { useEffect, useRef, useState, type ReactNode } from "react";
import { CalendarDays, Clock3, CloudOff, StickyNote } from "lucide-react";

const NOTES_KEY = "win11-widgets/notes";
const NOTES_DEBOUNCE_MS = 500;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/* ------------------------------------------------------------------ */
/* Card shell                                                          */
/* ------------------------------------------------------------------ */

function WidgetCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="widget-card">
      <header className="widget-card-header">
        <span className="widget-icon">{icon}</span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Clock                                                               */
/* ------------------------------------------------------------------ */

function ClockWidget() {
  const now = useNow(1000);
  return (
    <WidgetCard icon={<Clock3 size={16} />} title="Clock">
      <div className="clock-time">{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
      <div className="clock-date">{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</div>
    </WidgetCard>
  );
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"] as const;

/** Weeks of the month containing `date`; each week has 7 entries, null outside the month. */
function buildMonthGrid(date: Date): (number | null)[][] {
  const year = date.getFullYear();
  const month = date.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstWeekday = new Date(year, month, 1).getDay();
  const cells: (number | null)[] = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function CalendarWidget() {
  const now = useNow(30_000);
  const weeks = buildMonthGrid(now);
  const today = now.getDate();
  return (
    <WidgetCard icon={<CalendarDays size={16} />} title="Calendar">
      <div className="cal-month">{now.toLocaleDateString([], { month: "long", year: "numeric" })}</div>
      <div className="cal-grid" role="grid" aria-label="Current month">
        {WEEKDAYS.map((day) => (
          <span key={day} className="cal-weekday">{day}</span>
        ))}
        {weeks.flat().map((day, i) =>
          day === null ? (
            <span key={i} className="cal-day empty" />
          ) : (
            <span key={i} className={day === today ? "cal-day today" : "cal-day"}>{day}</span>
          ),
        )}
      </div>
    </WidgetCard>
  );
}

/* ------------------------------------------------------------------ */
/* Notes (autosaved through the MatrixOS bridge)                       */
/* ------------------------------------------------------------------ */

type SaveState = "loading" | "idle" | "saving" | "saved" | "error";

function NotesWidget() {
  const [text, setText] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("loading");
  const loaded = useRef(false);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const read = window.MatrixOS?.readData;
        if (!read) return;
        const value = await read(NOTES_KEY);
        if (!cancelled && typeof value === "string") setText(value);
      } catch (err: unknown) {
        console.warn("[widgets] notes load failed:", errMsg(err));
      } finally {
        if (!cancelled) {
          loaded.current = true;
          setSaveState("idle");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => {
    if (pending.current) clearTimeout(pending.current);
  }, []);

  const handleChange = (value: string) => {
    setText(value);
    if (!loaded.current) return;
    setSaveState("saving");
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      void (async () => {
        try {
          await window.MatrixOS?.writeData?.(NOTES_KEY, value);
          setSaveState("saved");
        } catch (err: unknown) {
          console.warn("[widgets] notes save failed:", errMsg(err));
          setSaveState("error");
        }
      })();
    }, NOTES_DEBOUNCE_MS);
  };

  const statusText =
    saveState === "loading"
      ? "Loading…"
      : saveState === "saving"
        ? "Saving…"
        : saveState === "saved"
          ? "Saved"
          : saveState === "error"
            ? "Save failed"
            : "";

  return (
    <WidgetCard icon={<StickyNote size={16} />} title="Notes">
      <textarea
        className="notes-input"
        placeholder="Jot something down…"
        value={text}
        onChange={(e) => handleChange(e.target.value)}
        aria-label="Notes"
      />
      <div className={saveState === "error" ? "notes-status error" : "notes-status"}>{statusText}</div>
    </WidgetCard>
  );
}

/* ------------------------------------------------------------------ */
/* Weather (offline placeholder — no network calls from sandboxed apps) */
/* ------------------------------------------------------------------ */

function WeatherWidget() {
  return (
    <WidgetCard icon={<CloudOff size={16} />} title="Weather">
      <div className="weather-offline">
        <CloudOff size={40} strokeWidth={1.4} aria-hidden="true" />
        <strong>Weather unavailable offline</strong>
        <p>Forecast data needs a network connection. This widget never leaves your machine.</p>
      </div>
    </WidgetCard>
  );
}

/* ------------------------------------------------------------------ */

export default function App() {
  return (
    <div className="widgets-app">
      <header className="widgets-header">
        <h1>Widgets</h1>
        <p>Your day at a glance</p>
      </header>
      <main className="widgets-grid">
        <ClockWidget />
        <CalendarWidget />
        <NotesWidget />
        <WeatherWidget />
      </main>
    </div>
  );
}
