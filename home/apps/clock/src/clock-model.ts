// Pure, UI-free helpers for the Clock app. Unit-tested in
// tests/default-apps/clock-model.test.ts.

export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface ZoneTime {
  /** Hour:minute label in 24h form, e.g. "14:05". */
  time: string;
  /** 12h hour string, e.g. "2". */
  hour12: string;
  minute: string;
  /** "AM" | "PM". */
  meridiem: string;
  /** Short weekday + relative day, e.g. "Mon, Today" / "Tue, Tomorrow" / "Sun, Yesterday". */
  dayLabel: string;
  /** Offset from the local zone, e.g. "+3h" / "-5h30m" / "Same time". */
  offsetLabel: string;
  /** Hour/minute/second hand angles in degrees for an analog face. */
  hourAngle: number;
  minuteAngle: number;
  secondAngle: number;
}

const MS_PER_MINUTE = 60_000;

/**
 * Cities seeded into the world clock on first run (before the user has saved
 * or deleted anything). Never re-seeded once storage has been written, so a
 * user who removes every city keeps an empty list.
 */
export const DEFAULT_WORLD_ZONES: readonly string[] = [
  "America/Los_Angeles", // Cupertino
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
];

/**
 * Return the wall-clock parts for a timezone using Intl. `now` defaults to the
 * current instant; pass an explicit Date for deterministic tests.
 */
export function zoneParts(
  timeZone: string,
  now: Date = new Date(),
): { year: number; month: number; day: number; hour: number; minute: number; second: number; weekday: WeekDay } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  const weekdayMap: Record<string, WeekDay> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  let hour = Number(get("hour"));
  if (hour === 24) hour = 0; // some engines emit 24 for midnight
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour,
    minute: Number(get("minute")),
    second: Number(get("second")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

/**
 * Offset in minutes of a timezone relative to UTC at the given instant.
 * Positive = ahead of UTC.
 */
export function zoneOffsetMinutes(timeZone: string, now: Date = new Date()): number {
  const p = zoneParts(timeZone, now);
  // Construct the UTC ms that the wall-clock parts represent, then diff with the
  // actual UTC instant. Rounded to the minute to avoid sub-minute drift.
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const diff = asUTC - now.getTime();
  return Math.round(diff / MS_PER_MINUTE);
}

function formatOffset(deltaMinutes: number): string {
  if (deltaMinutes === 0) return "Same time";
  const sign = deltaMinutes > 0 ? "+" : "-";
  const abs = Math.abs(deltaMinutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `${sign}${h}h` : `${sign}${h}h${m}m`;
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * Full render model for one saved zone, relative to a local reference zone.
 */
export function formatZoneTime(
  timeZone: string,
  localTimeZone: string,
  now: Date = new Date(),
): ZoneTime {
  const p = zoneParts(timeZone, now);
  const local = zoneParts(localTimeZone, now);

  const hh = p.hour.toString().padStart(2, "0");
  const mm = p.minute.toString().padStart(2, "0");
  const meridiem = p.hour >= 12 ? "PM" : "AM";
  let h12 = p.hour % 12;
  if (h12 === 0) h12 = 12;

  // Relative day vs local calendar day.
  const zoneDayNum = Date.UTC(p.year, p.month - 1, p.day);
  const localDayNum = Date.UTC(local.year, local.month - 1, local.day);
  const dayDelta = Math.round((zoneDayNum - localDayNum) / 86_400_000);
  let relative = "";
  if (dayDelta === 0) relative = "Today";
  else if (dayDelta === 1) relative = "Tomorrow";
  else if (dayDelta === -1) relative = "Yesterday";
  else relative = dayDelta > 0 ? `+${dayDelta} days` : `${dayDelta} days`;

  const deltaMinutes =
    zoneOffsetMinutes(timeZone, now) - zoneOffsetMinutes(localTimeZone, now);

  const hourAngle = (p.hour % 12) * 30 + p.minute * 0.5;
  const minuteAngle = p.minute * 6 + p.second * 0.1;
  const secondAngle = p.second * 6;

  return {
    time: `${hh}:${mm}`,
    hour12: String(h12),
    minute: mm,
    meridiem,
    dayLabel: `${WEEKDAY_SHORT[p.weekday]}, ${relative}`,
    offsetLabel: formatOffset(deltaMinutes),
    hourAngle,
    minuteAngle,
    secondAngle,
  };
}

/** Human label for a tz id, e.g. "America/New_York" -> "New York". */
export function zoneCityLabel(timeZone: string): string {
  const tail = timeZone.split("/").pop() ?? timeZone;
  return tail.replace(/_/g, " ");
}

/** Region label, e.g. "America/New_York" -> "America". */
export function zoneRegionLabel(timeZone: string): string {
  const head = timeZone.split("/")[0] ?? "";
  return head.replace(/_/g, " ");
}

/**
 * Case-insensitive substring filter over a tz id list. Returns at most `limit`.
 */
export function searchZones(zones: readonly string[], query: string, limit = 40): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return zones.slice(0, limit);
  const needle = q.replace(/\s+/g, "_");
  const out: string[] = [];
  for (const z of zones) {
    if (z.toLowerCase().includes(needle) || z.toLowerCase().includes(q)) {
      out.push(z);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

export interface AlarmModel {
  id: string;
  /** "HH:MM" 24h. */
  time: string;
  label: string;
  /** Sorted unique weekday numbers; empty = one-shot / every day handled by UI. */
  repeat: WeekDay[];
  enabled: boolean;
}

/** Parse a stored repeat string ("1,2,3") into a sorted unique WeekDay[]. */
export function parseRepeat(raw: unknown): WeekDay[] {
  if (Array.isArray(raw)) {
    return normalizeDays(raw.map((d) => Number(d)));
  }
  if (typeof raw === "string") {
    if (!raw.trim()) return [];
    return normalizeDays(raw.split(",").map((d) => Number(d.trim())));
  }
  return [];
}

export function serializeRepeat(days: WeekDay[]): string {
  return normalizeDays(days).join(",");
}

function normalizeDays(days: number[]): WeekDay[] {
  const set = new Set<WeekDay>();
  for (const d of days) {
    if (Number.isInteger(d) && d >= 0 && d <= 6) set.add(d as WeekDay);
  }
  return [...set].sort((a, b) => a - b);
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function repeatLabel(days: WeekDay[]): string {
  const d = normalizeDays(days);
  if (d.length === 0) return "Once";
  if (d.length === 7) return "Every day";
  if (d.length === 5 && d.every((x) => x >= 1 && x <= 5)) return "Weekdays";
  if (d.length === 2 && d.includes(0) && d.includes(6)) return "Weekends";
  return d.map((x) => DAY_NAMES[x]).join(" ");
}

/**
 * Decide whether an alarm should fire for the minute represented by `now`.
 * `lastFiredMinute` is a per-alarm guard key ("YYYY-MM-DD HH:MM" in local time)
 * to avoid re-firing within the same minute.
 */
export function alarmMinuteKey(now: Date): string {
  const y = now.getFullYear();
  const mo = (now.getMonth() + 1).toString().padStart(2, "0");
  const d = now.getDate().toString().padStart(2, "0");
  const h = now.getHours().toString().padStart(2, "0");
  const mi = now.getMinutes().toString().padStart(2, "0");
  return `${y}-${mo}-${d} ${h}:${mi}`;
}

export function shouldAlarmFire(alarm: AlarmModel, now: Date = new Date()): boolean {
  if (!alarm.enabled) return false;
  const [hStr, mStr] = alarm.time.split(":");
  const h = Number(hStr);
  const m = Number(mStr);
  if (!hStr || !mStr || !Number.isInteger(h) || !Number.isInteger(m)) return false;
  if (now.getHours() !== h || now.getMinutes() !== m) return false;
  const repeat = normalizeDays(alarm.repeat);
  if (repeat.length === 0) return true; // one-shot fires whenever the clock hits the time
  return repeat.includes(now.getDay() as WeekDay);
}

// ---------------------------------------------------------------------------
// Timer + Stopwatch formatting
// ---------------------------------------------------------------------------

/** Parse "1:30", "90", "1:02:03" into total seconds; returns 0 on garbage. */
export function parseDuration(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const parts = trimmed.split(":").map((p) => p.trim());
  if (parts.some((p) => p !== "" && !/^\d+$/.test(p))) return 0;
  const nums = parts.map((p) => Number(p || 0));
  if (nums.some((n) => !Number.isFinite(n))) return 0;
  let seconds = 0;
  if (nums.length === 1) seconds = nums[0];
  else if (nums.length === 2) seconds = nums[0] * 60 + nums[1];
  else if (nums.length === 3) seconds = nums[0] * 3600 + nums[1] * 60 + nums[2];
  else return 0;
  return Math.max(0, Math.floor(seconds));
}

/** Format whole seconds as "M:SS" or "H:MM:SS". */
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(safe / 3600);
  const m = Math.floor((safe % 3600) / 60);
  const s = safe % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Format milliseconds for the stopwatch as "MM:SS.cs" (centiseconds). */
export function formatStopwatch(ms: number): string {
  const safe = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safe / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const cs = Math.floor((safe % 1000) / 10);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}.${cs
    .toString()
    .padStart(2, "0")}`;
}

export interface LapModel {
  index: number;
  /** Lap split (this lap only) in ms. */
  lap: number;
  /** Cumulative elapsed at lap time in ms. */
  total: number;
}

/** Compute lap splits from cumulative lap-mark timestamps (ms elapsed). */
export function computeLaps(markTimes: number[]): LapModel[] {
  const laps: LapModel[] = [];
  let prev = 0;
  markTimes.forEach((total, i) => {
    laps.push({ index: i + 1, lap: total - prev, total });
    prev = total;
  });
  return laps;
}

/** Index of fastest/slowest lap in a list (by `lap`). Returns -1 for <2 laps. */
export function lapExtremes(laps: LapModel[]): { fastest: number; slowest: number } {
  if (laps.length < 2) return { fastest: -1, slowest: -1 };
  let fastest = 0;
  let slowest = 0;
  laps.forEach((l, i) => {
    if (l.lap < laps[fastest].lap) fastest = i;
    if (l.lap > laps[slowest].lap) slowest = i;
  });
  return { fastest, slowest };
}
