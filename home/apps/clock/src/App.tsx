import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  AlarmClock,
  Bell,
  Check,
  Clock3,
  Flag,
  Globe2,
  GripVertical,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Timer as TimerIcon,
  Trash2,
  X,
} from "lucide-react";
import "./styles.css";
import {
  alarmMinuteKey,
  computeLaps,
  formatClock,
  formatStopwatch,
  formatZoneTime,
  lapExtremes,
  parseDuration,
  parseRepeat,
  repeatLabel,
  searchZones,
  serializeRepeat,
  shouldAlarmFire,
  zoneCityLabel,
  zoneRegionLabel,
  type AlarmModel,
  type WeekDay,
} from "./clock-model";

const ZONES_TABLE = "zones";
const ALARMS_TABLE = "alarms";

type TabId = "world" | "alarms" | "timers" | "stopwatch";

const TABS: { id: TabId; label: string; icon: typeof Globe2 }[] = [
  { id: "world", label: "World Clock", icon: Globe2 },
  { id: "alarms", label: "Alarms", icon: AlarmClock },
  { id: "timers", label: "Timer", icon: TimerIcon },
  { id: "stopwatch", label: "Stopwatch", icon: Clock3 },
];

const LOCAL_TZ =
  (typeof Intl !== "undefined" && Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";

function allTimeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (typeof fn === "function") return fn("timeZone");
  } catch (err) {
    console.warn("[clock] supportedValuesOf failed:", err instanceof Error ? err.message : String(err));
  }
  return [
    "UTC",
    "America/New_York",
    "America/Los_Angeles",
    "America/Chicago",
    "Europe/London",
    "Europe/Paris",
    "Europe/Berlin",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Australia/Sydney",
  ];
}

// --- audio (WebAudio beep, gracefully degrades) --------------------------------

let sharedCtx: AudioContext | null = null;
function getCtx(): AudioContext | null {
  try {
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    if (!sharedCtx) sharedCtx = new Ctor();
    return sharedCtx;
  } catch (err) {
    console.warn("[clock] audio unavailable:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

function beep(times = 1): void {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    void ctx.resume?.();
    for (let i = 0; i < times; i++) {
      const start = ctx.currentTime + i * 0.5;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.42);
    }
  } catch (err) {
    console.warn("[clock] beep failed:", err instanceof Error ? err.message : String(err));
  }
}

// --- MatrixOS KV fallback ------------------------------------------------------

const fallbackData: Record<string, unknown> = {};

async function readAppData<T>(key: string, fallback: T): Promise<T> {
  try {
    if (window.MatrixOS?.readData) {
      const value = await window.MatrixOS.readData(key);
      return value === undefined || value === null ? fallback : (value as T);
    }
  } catch (err) {
    console.warn("[clock] MatrixOS data read failed:", err instanceof Error ? err.message : String(err));
  }
  return Object.prototype.hasOwnProperty.call(fallbackData, key) ? (fallbackData[key] as T) : fallback;
}

async function writeAppData<T>(key: string, value: T): Promise<void> {
  try {
    if (window.MatrixOS?.writeData) {
      await window.MatrixOS.writeData(key, value);
      return;
    }
  } catch (err) {
    console.warn("[clock] MatrixOS data write failed:", err instanceof Error ? err.message : String(err));
  }
  fallbackData[key] = value;
}

// --- shared types --------------------------------------------------------------

interface ZoneRow {
  id: string;
  tz: string;
  position: number;
}

function coerceZone(row: unknown, idx: number): ZoneRow | null {
  if (!row || typeof row !== "object") return null;
  const d = row as Record<string, unknown>;
  if (typeof d.tz !== "string" || !d.tz) return null;
  return {
    id: typeof d.id === "string" ? d.id : `local-${idx}`,
    tz: d.tz,
    position: typeof d.position === "number" ? d.position : idx,
  };
}

function coerceAlarm(row: unknown, idx: number): AlarmModel | null {
  if (!row || typeof row !== "object") return null;
  const d = row as Record<string, unknown>;
  if (typeof d.time !== "string") return null;
  return {
    id: typeof d.id === "string" ? d.id : `local-${idx}`,
    time: d.time,
    label: typeof d.label === "string" ? d.label : "",
    repeat: parseRepeat(d.repeat),
    enabled: d.enabled !== false,
  };
}

function dedupeZones(rows: ZoneRow[]): ZoneRow[] {
  const seen = new Set<string>();
  const deduped: ZoneRow[] = [];
  for (const zone of [...rows].sort((a, b) => a.position - b.position || a.tz.localeCompare(b.tz))) {
    if (seen.has(zone.tz)) continue;
    seen.add(zone.tz);
    deduped.push(zone);
  }
  return deduped;
}

// =================================================================================

export default function App() {
  const [tab, setTab] = useState<TabId>("world");
  const [now, setNow] = useState(() => new Date());

  // Global 1s tick used by world clock + alarms.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <main className="clock-app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Clock3 size={18} />
          </span>
          <span>Clock</span>
        </div>
        <nav className="tabs" role="tablist" aria-label="Clock sections">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={tab === id}
              className={tab === id ? "tab tab--active" : "tab"}
              onClick={() => setTab(id)}
            >
              <Icon size={16} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </header>

      <section className="panel" role="tabpanel">
        {tab === "world" && <WorldClock now={now} />}
        {tab === "alarms" && <Alarms now={now} />}
        {tab === "timers" && <Timers />}
        {tab === "stopwatch" && <Stopwatch />}
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------------
// World Clock
// ---------------------------------------------------------------------------------

function WorldClock({ now }: { now: Date }) {
  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [dragId, setDragId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allZones = useMemo(() => allTimeZones(), []);
  const hasDb = typeof window !== "undefined" && !!window.MatrixOS?.db;

  const reload = useCallback(async () => {
    setError(null);
    if (!window.MatrixOS?.db) {
      const stored = await readAppData<ZoneRow[]>("clock.zones", []);
      setZones(dedupeZones(stored.map(coerceZone).filter((z): z is ZoneRow => z !== null)));
      return;
    }
    try {
      const rows = await window.MatrixOS.db.find(ZONES_TABLE, { orderBy: { position: "asc" } });
      setZones(dedupeZones(rows.map(coerceZone).filter((z): z is ZoneRow => z !== null)));
    } catch (err: unknown) {
      console.warn("[clock] zones load failed:", err instanceof Error ? err.message : String(err));
      setError("Saved cities could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void reload();
    return window.MatrixOS?.db?.onChange?.(ZONES_TABLE, () => void reload());
  }, [reload]);

  const persistLocal = useCallback(async (next: ZoneRow[]) => {
    await writeAppData("clock.zones", next);
  }, []);

  const addZone = useCallback(
    async (tz: string) => {
      const alreadyVisible = zones.some((z) => z.tz === tz);
      let existingRows: Record<string, unknown>[] = [];
      try {
        existingRows = window.MatrixOS?.db
          ? await window.MatrixOS.db.find(ZONES_TABLE, { where: { tz }, limit: 1 })
          : [];
      } catch (err) {
        console.warn("[clock] duplicate zone check failed:", err instanceof Error ? err.message : String(err));
        setError("Saved cities could not be checked.");
        return;
      }
      if (alreadyVisible || existingRows.length > 0) {
        if (!alreadyVisible) await reload();
        setAdding(false);
        setQuery("");
        return;
      }
      const position = zones.length;
      const optimistic: ZoneRow = { id: `local-${Date.now()}`, tz, position };
      const next = [...zones, optimistic];
      setZones(next);
      setAdding(false);
      setQuery("");

      if (!window.MatrixOS?.db) {
        await persistLocal(next);
        return;
      }
      try {
        await window.MatrixOS.db.insert(ZONES_TABLE, { tz, position });
        await reload();
      } catch (err: unknown) {
        console.warn("[clock] zone save failed:", err instanceof Error ? err.message : String(err));
        setError("City could not be saved.");
        setZones((cur) => cur.filter((z) => z.id !== optimistic.id));
      }
    },
    [persistLocal, reload, zones],
  );

  const removeZone = useCallback(
    async (zone: ZoneRow) => {
      const next = zones.filter((z) => z.id !== zone.id);
      setZones(next);
      if (!window.MatrixOS?.db) {
        await persistLocal(next);
        return;
      }
      try {
        await window.MatrixOS.db.delete(ZONES_TABLE, zone.id);
      } catch (err: unknown) {
        console.warn("[clock] zone delete failed:", err instanceof Error ? err.message : String(err));
        setError("City could not be removed.");
        void reload();
      }
    },
    [persistLocal, reload, zones],
  );

  const reorder = useCallback(
    async (fromId: string, toId: string) => {
      if (fromId === toId) return;
      const fromIdx = zones.findIndex((z) => z.id === fromId);
      const toIdx = zones.findIndex((z) => z.id === toId);
      if (fromIdx < 0 || toIdx < 0) return;
      const next = [...zones];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(toIdx, 0, moved);
      const repositioned = next.map((z, i) => ({ ...z, position: i }));
      setZones(repositioned);
      if (!window.MatrixOS?.db) {
        await persistLocal(repositioned);
        return;
      }
      const previous = zones;
      try {
        for (const z of repositioned) {
          await window.MatrixOS.db.update(ZONES_TABLE, z.id, { position: z.position });
        }
      } catch (err: unknown) {
        console.warn("[clock] reorder failed:", err instanceof Error ? err.message : String(err));
        setError("New order could not be saved.");
        setZones(previous);
        void reload();
      }
    },
    [persistLocal, reload, zones],
  );

  const results = useMemo(() => searchZones(allZones, query, 60), [allZones, query]);

  useEffect(() => {
    if (adding) searchRef.current?.focus();
  }, [adding]);

  return (
    <div className="world">
      <div className="world-head">
        <div>
          <p className="eyebrow">{hasDb ? "Synced to Matrix Postgres" : "Saved on this device"}</p>
          <h1>World Clock</h1>
        </div>
        <button className="primary-btn" type="button" onClick={() => setAdding(true)}>
          <Plus size={16} /> Add city
        </button>
      </div>

      {error && <div className="banner banner--error">{error}</div>}

      {zones.length === 0 ? (
        <div className="empty">
          <Globe2 size={28} />
          <strong>No cities yet</strong>
          <span>Track the time anywhere. Add your first city to get started.</span>
          <button className="primary-btn" type="button" onClick={() => setAdding(true)}>
            <Plus size={16} /> Add city
          </button>
        </div>
      ) : (
        <ul className="zone-list">
          {zones.map((zone) => {
            const z = formatZoneTime(zone.tz, LOCAL_TZ, now);
            return (
              <li
                key={zone.id}
                className={dragId === zone.id ? "zone-row zone-row--drag" : "zone-row"}
                draggable
                onDragStart={() => setDragId(zone.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => {
                  if (dragId) void reorder(dragId, zone.id);
                  setDragId(null);
                }}
              >
                <span className="drag-handle" aria-hidden="true">
                  <GripVertical size={16} />
                </span>
                <AnalogFace zone={z} />
                <div className="zone-meta">
                  <strong>{zoneCityLabel(zone.tz)}</strong>
                  <span>
                    {z.dayLabel} · {z.offsetLabel} · {zoneRegionLabel(zone.tz)}
                  </span>
                </div>
                <div className="zone-time">
                  <strong>{z.time}</strong>
                  <span>{z.meridiem}</span>
                </div>
                <button
                  className="ghost-btn"
                  type="button"
                  aria-label={`Remove ${zoneCityLabel(zone.tz)}`}
                  onClick={() => void removeZone(zone)}
                >
                  <Trash2 size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {adding && (
        <div className="overlay" onClick={() => setAdding(false)}>
          <div className="search-card" onClick={(e) => e.stopPropagation()}>
            <div className="search-field">
              <Search size={16} />
              <input
                ref={searchRef}
                placeholder="Search cities or time zones"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setAdding(false);
                  if (e.key === "Enter" && results[0]) void addZone(results[0]);
                }}
              />
              <button className="ghost-btn" type="button" aria-label="Close" onClick={() => setAdding(false)}>
                <X size={16} />
              </button>
            </div>
            <ul className="option-list" role="listbox">
              {results.length === 0 ? (
                <li className="option option--empty">No matching time zones</li>
              ) : (
                results.map((tz) => (
                  <li key={tz}>
                    <button
                      className="option"
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => void addZone(tz)}
                    >
                      <span className="option-city">{zoneCityLabel(tz)}</span>
                      <span className="option-region">{zoneRegionLabel(tz)}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

function AnalogFace({ zone }: { zone: ReturnType<typeof formatZoneTime> }) {
  return (
    <div className="analog" aria-hidden="true">
      <span className="hand hand--hour" style={{ transform: `rotate(${zone.hourAngle}deg)` }} />
      <span className="hand hand--minute" style={{ transform: `rotate(${zone.minuteAngle}deg)` }} />
      <span className="hand hand--second" style={{ transform: `rotate(${zone.secondAngle}deg)` }} />
      <span className="analog-pin" />
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------------

const DAY_LETTERS: { day: WeekDay; label: string }[] = [
  { day: 1, label: "M" },
  { day: 2, label: "T" },
  { day: 3, label: "W" },
  { day: 4, label: "T" },
  { day: 5, label: "F" },
  { day: 6, label: "S" },
  { day: 0, label: "S" },
];

function Alarms({ now }: { now: Date }) {
  const [alarms, setAlarms] = useState<AlarmModel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draftTime, setDraftTime] = useState("07:00");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftDays, setDraftDays] = useState<WeekDay[]>([]);
  const [ringing, setRinging] = useState<AlarmModel | null>(null);
  const firedRef = useRef<Set<string>>(new Set());
  const hasDb = typeof window !== "undefined" && !!window.MatrixOS?.db;

  const reload = useCallback(async () => {
    setError(null);
    if (!window.MatrixOS?.db) {
      const stored = await readAppData<AlarmModel[]>("clock.alarms", []);
      setAlarms(stored.map((a) => ({ ...a, repeat: parseRepeat(a.repeat) })));
      return;
    }
    try {
      const rows = await window.MatrixOS.db.find(ALARMS_TABLE, { orderBy: { time: "asc" } });
      setAlarms(rows.map(coerceAlarm).filter((a): a is AlarmModel => a !== null));
    } catch (err: unknown) {
      console.warn("[clock] alarms load failed:", err instanceof Error ? err.message : String(err));
      setError("Alarms could not be loaded.");
    }
  }, []);

  useEffect(() => {
    void reload();
    return window.MatrixOS?.db?.onChange?.(ALARMS_TABLE, () => void reload());
  }, [reload]);

  const persistLocal = useCallback(async (next: AlarmModel[]) => {
    await writeAppData(
      "clock.alarms",
      next.map((a) => ({ ...a, repeat: serializeRepeat(a.repeat) })),
    );
  }, []);

  // Ring scheduling: when the global tick lands on a matching minute, fire once.
  useEffect(() => {
    const key = alarmMinuteKey(now);
    for (const alarm of alarms) {
      const guard = `${alarm.id}@${key}`;
      if (firedRef.current.has(guard)) continue;
      if (shouldAlarmFire(alarm, now)) {
        firedRef.current.add(guard);
        if (firedRef.current.size > 200) {
          firedRef.current = new Set([...firedRef.current].slice(-100));
        }
        setRinging(alarm);
        beep(3);
      }
    }
  }, [alarms, now]);

  const addAlarm = useCallback(async () => {
    const draft: AlarmModel = {
      id: `local-${Date.now()}`,
      time: draftTime,
      label: draftLabel.trim(),
      repeat: draftDays,
      enabled: true,
    };
    const next = [...alarms, draft].sort((a, b) => a.time.localeCompare(b.time));
    setAlarms(next);
    setEditing(false);
    setDraftLabel("");
    setDraftDays([]);
    setDraftTime("07:00");

    if (!window.MatrixOS?.db) {
      await persistLocal(next);
      return;
    }
    try {
      await window.MatrixOS.db.insert(ALARMS_TABLE, {
        time: draft.time,
        label: draft.label,
        repeat: serializeRepeat(draft.repeat),
        enabled: true,
      });
      await reload();
    } catch (err: unknown) {
      console.warn("[clock] alarm save failed:", err instanceof Error ? err.message : String(err));
      setError("Alarm could not be saved.");
      setAlarms((cur) => cur.filter((a) => a.id !== draft.id));
    }
  }, [alarms, draftDays, draftLabel, draftTime, persistLocal, reload]);

  const toggleAlarm = useCallback(
    async (alarm: AlarmModel) => {
      const enabled = !alarm.enabled;
      const next = alarms.map((a) => (a.id === alarm.id ? { ...a, enabled } : a));
      setAlarms(next);
      if (!window.MatrixOS?.db) {
        await persistLocal(next);
        return;
      }
      try {
        await window.MatrixOS.db.update(ALARMS_TABLE, alarm.id, { enabled });
      } catch (err: unknown) {
        console.warn("[clock] alarm toggle failed:", err instanceof Error ? err.message : String(err));
        setError("Alarm could not be updated.");
        void reload();
      }
    },
    [alarms, persistLocal, reload],
  );

  const removeAlarm = useCallback(
    async (alarm: AlarmModel) => {
      const next = alarms.filter((a) => a.id !== alarm.id);
      setAlarms(next);
      if (!window.MatrixOS?.db) {
        await persistLocal(next);
        return;
      }
      try {
        await window.MatrixOS.db.delete(ALARMS_TABLE, alarm.id);
      } catch (err: unknown) {
        console.warn("[clock] alarm delete failed:", err instanceof Error ? err.message : String(err));
        setError("Alarm could not be removed.");
        void reload();
      }
    },
    [alarms, persistLocal, reload],
  );

  const snooze = useCallback(() => {
    // Re-arm guard for the next minute so it does not instantly re-ring.
    setRinging(null);
  }, []);

  const toggleDraftDay = (day: WeekDay) =>
    setDraftDays((cur) => (cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day]));

  return (
    <div className="alarms">
      <div className="world-head">
        <div>
          <p className="eyebrow">{hasDb ? "Synced to Matrix Postgres" : "Saved on this device"}</p>
          <h1>Alarms</h1>
        </div>
        <button className="primary-btn" type="button" onClick={() => setEditing(true)}>
          <Plus size={16} /> New alarm
        </button>
      </div>

      {error && <div className="banner banner--error">{error}</div>}

      {alarms.length === 0 ? (
        <div className="empty">
          <Bell size={28} />
          <strong>No alarms set</strong>
          <span>Alarms ring while Clock is open. Create one to wake up or stay on schedule.</span>
          <button className="primary-btn" type="button" onClick={() => setEditing(true)}>
            <Plus size={16} /> New alarm
          </button>
        </div>
      ) : (
        <ul className="alarm-list">
          {alarms.map((alarm) => (
            <li key={alarm.id} className={alarm.enabled ? "alarm-row" : "alarm-row alarm-row--off"}>
              <div className="alarm-meta">
                <strong>{alarm.time}</strong>
                <span>
                  {alarm.label ? `${alarm.label} · ` : ""}
                  {repeatLabel(alarm.repeat)}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={alarm.enabled}
                aria-label={`${alarm.enabled ? "Disable" : "Enable"} alarm ${alarm.time}`}
                className={alarm.enabled ? "toggle toggle--on" : "toggle"}
                onClick={() => void toggleAlarm(alarm)}
              >
                <span className="toggle-knob" />
              </button>
              <button
                className="ghost-btn"
                type="button"
                aria-label={`Delete alarm ${alarm.time}`}
                onClick={() => void removeAlarm(alarm)}
              >
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <div className="overlay" onClick={() => setEditing(false)}>
          <div className="edit-card" onClick={(e) => e.stopPropagation()}>
            <h2>New alarm</h2>
            <label className="field">
              <span>Time</span>
              <input type="time" value={draftTime} onChange={(e) => setDraftTime(e.target.value)} />
            </label>
            <label className="field">
              <span>Label</span>
              <input
                type="text"
                placeholder="Wake up"
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void addAlarm();
                  if (e.key === "Escape") setEditing(false);
                }}
              />
            </label>
            <div className="field">
              <span>Repeat</span>
              <div className="day-picker">
                {DAY_LETTERS.map(({ day, label }) => (
                  <button
                    key={day}
                    type="button"
                    aria-pressed={draftDays.includes(day)}
                    className={draftDays.includes(day) ? "day day--on" : "day"}
                    onClick={() => toggleDraftDay(day)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="edit-actions">
              <button className="secondary-btn" type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary-btn" type="button" onClick={() => void addAlarm()}>
                <Check size={16} /> Save alarm
              </button>
            </div>
          </div>
        </div>
      )}

      {ringing && (
        <div className="overlay overlay--ring">
          <div className="ring-card">
            <span className="ring-mark">
              <Bell size={28} />
            </span>
            <strong>{ringing.time}</strong>
            <span>{ringing.label || "Alarm"}</span>
            <div className="edit-actions">
              <button className="secondary-btn" type="button" onClick={snooze}>
                Snooze
              </button>
              <button className="primary-btn" type="button" onClick={() => setRinging(null)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------------

interface TimerInstance {
  id: string;
  label: string;
  total: number; // seconds
  remaining: number; // seconds
  running: boolean;
  done: boolean;
}

const PRESETS = [
  { label: "1 min", seconds: 60 },
  { label: "5 min", seconds: 300 },
  { label: "10 min", seconds: 600 },
  { label: "25 min", seconds: 1500 },
];

function Timers() {
  const [timers, setTimers] = useState<TimerInstance[]>([]);
  const [draft, setDraft] = useState("5:00");
  const [label, setLabel] = useState("");

  useEffect(() => {
    const id = window.setInterval(() => {
      setTimers((cur) => {
        let changed = false;
        const next = cur.map((t) => {
          if (!t.running || t.remaining <= 0) return t;
          changed = true;
          const remaining = t.remaining - 1;
          if (remaining <= 0) {
            beep(3);
            return { ...t, remaining: 0, running: false, done: true };
          }
          return { ...t, remaining };
        });
        return changed ? next : cur;
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const addTimer = useCallback(
    (seconds: number, name = "") => {
      if (seconds <= 0) return;
      setTimers((cur) => [
        {
          id: `t-${Date.now()}-${cur.length}`,
          label: name.trim(),
          total: seconds,
          remaining: seconds,
          running: true,
          done: false,
        },
        ...cur,
      ]);
    },
    [],
  );

  const startCustom = useCallback(() => {
    const seconds = parseDuration(draft);
    addTimer(seconds, label);
    setLabel("");
  }, [addTimer, draft, label]);

  const toggle = (id: string) =>
    setTimers((cur) =>
      cur.map((t) =>
        t.id === id ? { ...t, running: !t.running && t.remaining > 0, done: false } : t,
      ),
    );
  const reset = (id: string) =>
    setTimers((cur) => cur.map((t) => (t.id === id ? { ...t, remaining: t.total, running: false, done: false } : t)));
  const remove = (id: string) => setTimers((cur) => cur.filter((t) => t.id !== id));

  return (
    <div className="timers">
      <div className="world-head">
        <div>
          <p className="eyebrow">Session only</p>
          <h1>Timer</h1>
        </div>
      </div>

      <div className="timer-setup">
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.label} className="chip" type="button" onClick={() => addTimer(p.seconds)}>
              {p.label}
            </button>
          ))}
        </div>
        <div className="custom-row">
          <input
            className="duration-input"
            aria-label="Timer duration"
            placeholder="MM:SS"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startCustom()}
          />
          <input
            className="label-input"
            aria-label="Timer label"
            placeholder="Label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startCustom()}
          />
          <button className="primary-btn" type="button" onClick={startCustom}>
            <Plus size={16} /> Start
          </button>
        </div>
      </div>

      {timers.length === 0 ? (
        <div className="empty">
          <TimerIcon size={28} />
          <strong>No timers running</strong>
          <span>Pick a preset or enter a duration to start a countdown.</span>
        </div>
      ) : (
        <ul className="timer-list">
          {timers.map((t) => {
            const pct = t.total > 0 ? 1 - t.remaining / t.total : 1;
            return (
              <li key={t.id} className={t.done ? "timer-card timer-card--done" : "timer-card"}>
                <div
                  className="timer-ring"
                  style={{ "--p": `${Math.max(0, Math.min(360, pct * 360))}deg` } as React.CSSProperties}
                >
                  <div className="timer-ring-core">
                    <strong>{formatClock(t.remaining)}</strong>
                    {t.label && <span>{t.label}</span>}
                    {t.done && <em>Done</em>}
                  </div>
                </div>
                <div className="timer-controls">
                  <button className="icon-btn" type="button" aria-label="Start or pause" onClick={() => toggle(t.id)}>
                    {t.running ? <Pause size={18} /> : <Play size={18} />}
                  </button>
                  <button className="icon-btn" type="button" aria-label="Reset timer" onClick={() => reset(t.id)}>
                    <RotateCcw size={18} />
                  </button>
                  <button className="icon-btn" type="button" aria-label="Remove timer" onClick={() => remove(t.id)}>
                    <Trash2 size={18} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------
// Stopwatch
// ---------------------------------------------------------------------------------

interface SwState {
  running: boolean;
  elapsed: number; // accumulated ms while paused
  startedAt: number | null; // performance.now() when started
  marks: number[]; // cumulative elapsed ms at each lap
}

type SwAction =
  | { type: "start"; at: number }
  | { type: "stop"; at: number }
  | { type: "reset" }
  | { type: "lap"; at: number };

function nowElapsed(s: SwState, at: number): number {
  return s.running && s.startedAt !== null ? s.elapsed + (at - s.startedAt) : s.elapsed;
}

function swReducer(s: SwState, a: SwAction): SwState {
  switch (a.type) {
    case "start":
      if (s.running) return s;
      return { ...s, running: true, startedAt: a.at };
    case "stop":
      if (!s.running) return s;
      return { ...s, running: false, elapsed: nowElapsed(s, a.at), startedAt: null };
    case "reset":
      return { running: false, elapsed: 0, startedAt: null, marks: [] };
    case "lap":
      return { ...s, marks: [...s.marks, nowElapsed(s, a.at)] };
    default:
      return s;
  }
}

function Stopwatch() {
  const [state, dispatch] = useReducer(swReducer, {
    running: false,
    elapsed: 0,
    startedAt: null,
    marks: [],
  });
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    if (!state.running) {
      setDisplay(state.elapsed);
      return undefined;
    }
    let raf = 0;
    const tick = () => {
      setDisplay(nowElapsed(state, performance.now()));
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(raf);
  }, [state]);

  const laps = useMemo(() => computeLaps(state.marks), [state.marks]);
  const ext = useMemo(() => lapExtremes(laps), [laps]);

  return (
    <div className="stopwatch">
      <div className="sw-readout" data-testid="stopwatch-readout">
        {formatStopwatch(display)}
      </div>

      <div className="sw-controls">
        {!state.running ? (
          <button className="primary-btn primary-btn--lg" type="button" onClick={() => dispatch({ type: "start", at: performance.now() })}>
            <Play size={18} /> Start
          </button>
        ) : (
          <button className="primary-btn primary-btn--lg" type="button" onClick={() => dispatch({ type: "stop", at: performance.now() })}>
            <Pause size={18} /> Stop
          </button>
        )}
        <button
          className="secondary-btn secondary-btn--lg"
          type="button"
          disabled={!state.running}
          onClick={() => dispatch({ type: "lap", at: performance.now() })}
        >
          <Flag size={18} /> Lap
        </button>
        <button
          className="secondary-btn secondary-btn--lg"
          type="button"
          disabled={state.running || (state.elapsed === 0 && state.marks.length === 0)}
          onClick={() => dispatch({ type: "reset" })}
        >
          <RotateCcw size={18} /> Reset
        </button>
      </div>

      {laps.length === 0 ? (
        <div className="empty empty--sw">
          <Clock3 size={28} />
          <strong>No laps yet</strong>
          <span>Start the stopwatch, then tap Lap to record splits.</span>
        </div>
      ) : (
        <ul className="lap-list">
          {[...laps].reverse().map((lap) => (
            <li
              key={lap.index}
              className={
                lap.index - 1 === ext.fastest
                  ? "lap-row lap-row--fast"
                  : lap.index - 1 === ext.slowest
                    ? "lap-row lap-row--slow"
                    : "lap-row"
              }
            >
              <span>Lap {lap.index}</span>
              <span className="lap-split">{formatStopwatch(lap.lap)}</span>
              <span className="lap-total">{formatStopwatch(lap.total)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
