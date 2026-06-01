// Pure, UI-free weather helpers. Unit tested in tests/default-apps/weather-model.test.ts
// Open-Meteo WMO weather code mapping + formatting + grouping utilities.

export type WeatherKind =
  | "clear"
  | "cloudy"
  | "fog"
  | "drizzle"
  | "rain"
  | "snow"
  | "thunder";

export interface WeatherVisual {
  /** WMO code that produced this visual. */
  code: number;
  /** Short human label, e.g. "Partly Cloudy". */
  label: string;
  /** Coarse condition family used for icon + gradient selection. */
  kind: WeatherKind;
  /** Lucide icon name to render. */
  icon: string;
  /** CSS gradient string for the hero, day variant. */
  gradientDay: string;
  /** CSS gradient string for the hero, night variant. */
  gradientNight: string;
  /** Foreground text tone that reads on the gradient. */
  tone: "light" | "dark";
}

interface CodeSpec {
  label: string;
  kind: WeatherKind;
  icon: string;
}

// WMO weather interpretation codes used by Open-Meteo.
// https://open-meteo.com/en/docs
const CODE_TABLE: Record<number, CodeSpec> = {
  0: { label: "Clear Sky", kind: "clear", icon: "sun" },
  1: { label: "Mainly Clear", kind: "clear", icon: "sun" },
  2: { label: "Partly Cloudy", kind: "cloudy", icon: "cloud-sun" },
  3: { label: "Overcast", kind: "cloudy", icon: "cloud" },
  45: { label: "Fog", kind: "fog", icon: "cloud-fog" },
  48: { label: "Rime Fog", kind: "fog", icon: "cloud-fog" },
  51: { label: "Light Drizzle", kind: "drizzle", icon: "cloud-drizzle" },
  53: { label: "Drizzle", kind: "drizzle", icon: "cloud-drizzle" },
  55: { label: "Heavy Drizzle", kind: "drizzle", icon: "cloud-drizzle" },
  56: { label: "Freezing Drizzle", kind: "drizzle", icon: "cloud-drizzle" },
  57: { label: "Freezing Drizzle", kind: "drizzle", icon: "cloud-drizzle" },
  61: { label: "Light Rain", kind: "rain", icon: "cloud-rain" },
  63: { label: "Rain", kind: "rain", icon: "cloud-rain" },
  65: { label: "Heavy Rain", kind: "rain", icon: "cloud-rain-wind" },
  66: { label: "Freezing Rain", kind: "rain", icon: "cloud-rain" },
  67: { label: "Freezing Rain", kind: "rain", icon: "cloud-rain-wind" },
  71: { label: "Light Snow", kind: "snow", icon: "cloud-snow" },
  73: { label: "Snow", kind: "snow", icon: "cloud-snow" },
  75: { label: "Heavy Snow", kind: "snow", icon: "snowflake" },
  77: { label: "Snow Grains", kind: "snow", icon: "snowflake" },
  80: { label: "Light Showers", kind: "rain", icon: "cloud-rain" },
  81: { label: "Showers", kind: "rain", icon: "cloud-rain" },
  82: { label: "Violent Showers", kind: "rain", icon: "cloud-rain-wind" },
  85: { label: "Snow Showers", kind: "snow", icon: "cloud-snow" },
  86: { label: "Snow Showers", kind: "snow", icon: "cloud-snow" },
  95: { label: "Thunderstorm", kind: "thunder", icon: "cloud-lightning" },
  96: { label: "Thunderstorm", kind: "thunder", icon: "cloud-lightning" },
  99: { label: "Severe Thunderstorm", kind: "thunder", icon: "cloud-lightning" },
};

const FALLBACK: CodeSpec = { label: "Unknown", kind: "cloudy", icon: "cloud" };

const GRADIENTS: Record<WeatherKind, { day: string; night: string; tone: "light" | "dark" }> = {
  clear: {
    day: "linear-gradient(160deg, #4aa3df 0%, #7cc6f0 55%, #bfe3f7 100%)",
    night: "linear-gradient(160deg, #0f1f3d 0%, #1d335c 60%, #2c4a7e 100%)",
    tone: "light",
  },
  cloudy: {
    day: "linear-gradient(160deg, #6f8398 0%, #9aabbc 55%, #c4cfd9 100%)",
    night: "linear-gradient(160deg, #1c2530 0%, #313e4d 60%, #4a5a6b 100%)",
    tone: "light",
  },
  fog: {
    day: "linear-gradient(160deg, #8d97a1 0%, #b3bbc3 55%, #d6dbe0 100%)",
    night: "linear-gradient(160deg, #232a31 0%, #3a444d 60%, #545f69 100%)",
    tone: "light",
  },
  drizzle: {
    day: "linear-gradient(160deg, #5b7d99 0%, #7c9bb4 55%, #a7c0d3 100%)",
    night: "linear-gradient(160deg, #131f2c 0%, #243646 60%, #38516a 100%)",
    tone: "light",
  },
  rain: {
    day: "linear-gradient(160deg, #44617a 0%, #5d7e99 55%, #88a6bd 100%)",
    night: "linear-gradient(160deg, #0d1620 0%, #1c2c3b 60%, #2d4359 100%)",
    tone: "light",
  },
  snow: {
    day: "linear-gradient(160deg, #7f93a8 0%, #aebfce 55%, #e2ebf4 100%)",
    night: "linear-gradient(160deg, #1d2733 0%, #36475a 60%, #5b7088 100%)",
    tone: "light",
  },
  thunder: {
    day: "linear-gradient(160deg, #3a3f55 0%, #545a78 55%, #7d83a3 100%)",
    night: "linear-gradient(160deg, #0c0d16 0%, #1f2236 60%, #383c5c 100%)",
    tone: "light",
  },
};

/** Map an Open-Meteo WMO weather code to a visual descriptor. */
export function weatherVisual(code: number): WeatherVisual {
  const spec = CODE_TABLE[code] ?? FALLBACK;
  const g = GRADIENTS[spec.kind];
  return {
    code,
    label: spec.label,
    kind: spec.kind,
    icon: spec.icon,
    gradientDay: g.day,
    gradientNight: g.night,
    tone: g.tone,
  };
}

/** Whether a given ISO timestamp is during daytime given sunrise/sunset bounds. */
export function isDaytime(iso: string, sunrise?: string, sunset?: string): boolean {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return true;
  if (sunrise && sunset) {
    const rise = new Date(sunrise).getTime();
    const set = new Date(sunset).getTime();
    if (Number.isFinite(rise) && Number.isFinite(set)) {
      return t >= rise && t < set;
    }
  }
  const hour = new Date(iso).getHours();
  return hour >= 6 && hour < 19;
}

export type Unit = "c" | "f";

/** Format a temperature value (always stored in Celsius) for display. */
export function formatTemp(celsius: number, unit: Unit = "c"): string {
  return `${Math.round(toUnit(celsius, unit))}°`;
}

/** Convert a Celsius value to the requested unit (numeric, unrounded). */
export function toUnit(celsius: number, unit: Unit): number {
  if (!Number.isFinite(celsius)) return 0;
  return unit === "f" ? celsius * 1.8 + 32 : celsius;
}

/** Short hour label, e.g. "3 PM" or "Now" when isNow. */
export function formatHour(iso: string, isNow = false): string {
  if (isNow) return "Now";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  const h = d.getHours();
  const period = h >= 12 ? "PM" : "AM";
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display} ${period}`;
}

/** Short weekday label, e.g. "Mon", or "Today" for the current day. */
export function formatDay(iso: string, todayIso?: string): string {
  const todayKey = todayIso?.slice(0, 10) ?? localDateKey(new Date());
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    if (iso === todayKey) return "Today";
    const [year, month, day] = iso.split("-").map(Number);
    return new Date(year, month - 1, day).toLocaleDateString("en-US", { weekday: "short" });
  }
  const isoKey = iso.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoKey === todayKey) return "Today";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleDateString("en-US", { weekday: "short" });
}

function localDateKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export interface HourPoint {
  time: string;
  tempC: number;
  code: number;
  isNow: boolean;
}

export interface DayPoint {
  date: string;
  highC: number;
  lowC: number;
  code: number;
}

export interface OpenMeteoForecast {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    weather_code?: number;
    is_day?: number;
    relative_humidity_2m?: number;
    wind_speed_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    weather_code?: number[];
  };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    sunrise?: string[];
    sunset?: string[];
  };
}

/**
 * Build the next ~24h of hourly points starting at (or just after) `nowIso`.
 * Marks the first slot at/after now as "Now".
 */
export function buildHourly(forecast: OpenMeteoForecast, nowIso?: string, count = 24): HourPoint[] {
  const times = forecast.hourly?.time ?? [];
  const temps = forecast.hourly?.temperature_2m ?? [];
  const codes = forecast.hourly?.weather_code ?? [];
  if (times.length === 0) return [];

  const now = nowIso ? new Date(nowIso).getTime() : Date.now();
  let startIdx = times.findIndex((t) => new Date(t).getTime() >= now);
  if (startIdx < 0) startIdx = 0;

  const out: HourPoint[] = [];
  for (let i = startIdx; i < times.length && out.length < count; i += 1) {
    out.push({
      time: times[i],
      tempC: temps[i] ?? 0,
      code: codes[i] ?? 0,
      isNow: out.length === 0,
    });
  }
  return out;
}

/** Build daily points (next `count` days) from the daily block. */
export function buildDaily(forecast: OpenMeteoForecast, count = 7): DayPoint[] {
  const days = forecast.daily?.time ?? [];
  const codes = forecast.daily?.weather_code ?? [];
  const max = forecast.daily?.temperature_2m_max ?? [];
  const min = forecast.daily?.temperature_2m_min ?? [];
  const out: DayPoint[] = [];
  for (let i = 0; i < days.length && out.length < count; i += 1) {
    out.push({
      date: days[i],
      highC: max[i] ?? 0,
      lowC: min[i] ?? 0,
      code: codes[i] ?? 0,
    });
  }
  return out;
}

/** Compute the high/low temperature span across daily points (for the range bars). */
export function tempSpan(days: DayPoint[]): { min: number; max: number } {
  if (days.length === 0) return { min: 0, max: 0 };
  let min = Infinity;
  let max = -Infinity;
  for (const d of days) {
    if (d.lowC < min) min = d.lowC;
    if (d.highC > max) max = d.highC;
  }
  return { min, max };
}

export interface SavedLocation {
  id?: string;
  name: string;
  latitude: number;
  longitude: number;
  is_default?: boolean;
}

export const DEMO_LOCATION: SavedLocation = {
  name: "San Francisco",
  latitude: 37.7749,
  longitude: -122.4194,
  is_default: true,
};

/**
 * Generate a deterministic, plausible demo forecast for offline/no-network
 * fallback. Anchored to `baseIso` so the "Now" slot lines up with reality.
 */
export function demoForecast(baseIso?: string): OpenMeteoForecast {
  const base = baseIso ? new Date(baseIso) : new Date();
  base.setMinutes(0, 0, 0);
  const codeCycle = [1, 2, 3, 2, 61, 80, 3, 1];

  const hourlyTime: string[] = [];
  const hourlyTemp: number[] = [];
  const hourlyCode: number[] = [];
  for (let i = 0; i < 24; i += 1) {
    const t = new Date(base.getTime() + i * 3_600_000);
    hourlyTime.push(t.toISOString());
    // Mild diurnal curve peaking mid-afternoon.
    const hour = t.getHours();
    const temp = 14 + 6 * Math.sin(((hour - 6) / 24) * Math.PI * 2);
    hourlyTemp.push(Math.round(temp * 10) / 10);
    hourlyCode.push(codeCycle[hour % codeCycle.length]);
  }

  const dayDate: string[] = [];
  const dayMax: number[] = [];
  const dayMin: number[] = [];
  const dayCode: number[] = [];
  const dayStart = new Date(base);
  dayStart.setHours(0, 0, 0, 0);
  const dailyCodes = [1, 2, 3, 61, 80, 2, 1];
  const highs = [19, 18, 16, 15, 17, 20, 21];
  const lows = [11, 10, 9, 9, 10, 12, 13];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(dayStart.getTime() + i * 86_400_000);
    dayDate.push(d.toISOString().slice(0, 10));
    dayMax.push(highs[i]);
    dayMin.push(lows[i]);
    dayCode.push(dailyCodes[i]);
  }

  const sunrise = new Date(dayStart.getTime() + 6.5 * 3_600_000).toISOString();
  const sunset = new Date(dayStart.getTime() + 19.5 * 3_600_000).toISOString();

  return {
    current: {
      time: base.toISOString(),
      temperature_2m: hourlyTemp[0],
      apparent_temperature: hourlyTemp[0] - 1.5,
      weather_code: hourlyCode[0],
      is_day: isDaytime(base.toISOString(), sunrise, sunset) ? 1 : 0,
      relative_humidity_2m: 68,
      wind_speed_10m: 12,
    },
    hourly: { time: hourlyTime, temperature_2m: hourlyTemp, weather_code: hourlyCode },
    daily: {
      time: dayDate,
      weather_code: dayCode,
      temperature_2m_max: dayMax,
      temperature_2m_min: dayMin,
      sunrise: [sunrise],
      sunset: [sunset],
    },
  };
}

/** Normalize a possibly-untrusted DB or bridge-KV row into a SavedLocation. */
export function coerceLocation(row: unknown): SavedLocation | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const latitude = typeof r.latitude === "number" ? r.latitude : Number(r.latitude);
  const longitude = typeof r.longitude === "number" ? r.longitude : Number(r.longitude);
  if (!name) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return {
    id: typeof r.id === "string" ? r.id : undefined,
    name,
    latitude,
    longitude,
    is_default: r.is_default === true,
  };
}
