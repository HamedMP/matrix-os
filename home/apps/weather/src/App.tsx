import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Droplets,
  MapPin,
  Plus,
  Search,
  Trash2,
  Wind,
  X,
} from "lucide-react";
import {
  buildDaily,
  buildHourly,
  coerceLocation,
  DEMO_LOCATION,
  demoForecast,
  formatDay,
  formatHour,
  formatTemp,
  isDaytime,
  tempSpan,
  weatherVisual,
  type OpenMeteoForecast,
  type SavedLocation,
  type Unit,
} from "./weather-model";
import { fetchForecast, geocode, type GeoResult } from "./weather-api";
import { WeatherIcon } from "./WeatherIcon";
import "./styles.css";

const LOCATIONS_TABLE = "locations";
const LS_KEY = "matrix-weather-locations";
const LS_UNIT = "matrix-weather-unit";

type LoadStatus = "loading" | "live" | "demo";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readLocalLocations(): SavedLocation[] {
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(coerceLocation).filter((l): l is SavedLocation => l !== null);
  } catch (err: unknown) {
    console.warn("[weather] local locations read failed:", errMsg(err));
    return [];
  }
}

function writeLocalLocations(locations: SavedLocation[]): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(locations));
  } catch (err: unknown) {
    console.warn("[weather] local locations write failed:", errMsg(err));
  }
}

export default function App() {
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [forecast, setForecast] = useState<OpenMeteoForecast | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [unit, setUnit] = useState<Unit>(() => {
    try {
      return window.localStorage.getItem(LS_UNIT) === "f" ? "f" : "c";
    } catch {
      return "c";
    }
  });

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const reloadLocations = useCallback(async () => {
    const db = window.MatrixOS?.db;
    if (!db) {
      setLocations(readLocalLocations());
      return;
    }
    try {
      const rows = await db.find(LOCATIONS_TABLE, { orderBy: { created_at: "asc" } });
      const parsed = rows.map(coerceLocation).filter((l): l is SavedLocation => l !== null);
      setLocations(parsed);
    } catch (err: unknown) {
      console.warn("[weather] location load failed:", errMsg(err));
      setError("Saved locations could not be loaded.");
      setLocations(readLocalLocations());
    }
  }, []);

  useEffect(() => {
    void reloadLocations();
    const db = window.MatrixOS?.db;
    if (!db?.onChange) return undefined;
    try {
      return db.onChange(LOCATIONS_TABLE, () => void reloadLocations());
    } catch (err: unknown) {
      console.warn("[weather] onChange subscribe failed:", errMsg(err));
      return undefined;
    }
  }, [reloadLocations]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LS_UNIT, unit);
    } catch (err: unknown) {
      console.warn("[weather] unit persist failed:", errMsg(err));
    }
  }, [unit]);

  // Keep an active selection in sync with the available locations.
  useEffect(() => {
    if (locations.length === 0) {
      setActiveId(null);
      return;
    }
    const stillThere = activeId && locations.some((l) => (l.id ?? l.name) === activeId);
    if (!stillThere) {
      const def = locations.find((l) => l.is_default) ?? locations[0];
      setActiveId(def.id ?? def.name);
    }
  }, [locations, activeId]);

  const active = useMemo<SavedLocation | null>(() => {
    if (locations.length === 0) return null;
    return locations.find((l) => (l.id ?? l.name) === activeId) ?? locations[0];
  }, [locations, activeId]);

  // Load forecast for the active location with graceful demo fallback.
  useEffect(() => {
    if (!active) {
      setForecast(null);
      setStatus("loading");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setError(null);
    (async () => {
      try {
        const data = await fetchForecast(active);
        if (cancelled) return;
        setForecast(data);
        setStatus("live");
      } catch (err: unknown) {
        if (cancelled) return;
        console.warn("[weather] forecast fetch failed:", errMsg(err));
        setForecast(demoForecast());
        setStatus("demo");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active]);

  // Debounced geocode search.
  useEffect(() => {
    if (!searchOpen) return undefined;
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return undefined;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    const handle = window.setTimeout(async () => {
      try {
        const found = await geocode(q);
        if (seq !== searchSeq.current) return;
        setResults(found);
        setSearchError(found.length === 0 ? "No matching places." : null);
      } catch (err: unknown) {
        if (seq !== searchSeq.current) return;
        console.warn("[weather] geocode failed:", errMsg(err));
        setSearchError("Search is unavailable right now.");
        setResults([]);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 280);
    return () => window.clearTimeout(handle);
  }, [query, searchOpen]);

  const addLocation = useCallback(
    async (geo: GeoResult) => {
      const label = geo.admin1 && geo.admin1 !== geo.name ? `${geo.name}` : geo.name;
      const candidate: SavedLocation = {
        name: label,
        latitude: geo.latitude,
        longitude: geo.longitude,
        is_default: locations.length === 0,
      };
      // Optimistic add.
      const optimistic: SavedLocation = { ...candidate, id: `local-${Date.now()}` };
      setLocations((curr) => [...curr, optimistic]);
      setActiveId(optimistic.id!);
      setSearchOpen(false);
      setQuery("");
      setResults([]);

      const db = window.MatrixOS?.db;
      if (!db) {
        writeLocalLocations([...locations, candidate]);
        return;
      }
      try {
        const { id } = await db.insert(LOCATIONS_TABLE, {
          name: candidate.name,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          is_default: candidate.is_default ?? false,
        });
        setActiveId(id);
        await reloadLocations();
      } catch (err: unknown) {
        console.warn("[weather] location save failed:", errMsg(err));
        setError("Location could not be saved.");
      }
    },
    [locations, reloadLocations],
  );

  const removeLocation = useCallback(
    async (loc: SavedLocation) => {
      setLocations((curr) => curr.filter((l) => (l.id ?? l.name) !== (loc.id ?? loc.name)));
      const db = window.MatrixOS?.db;
      if (!db) {
        writeLocalLocations(locations.filter((l) => (l.id ?? l.name) !== (loc.id ?? loc.name)));
        return;
      }
      if (!loc.id || loc.id.startsWith("local-")) return;
      try {
        await db.delete(LOCATIONS_TABLE, loc.id);
        await reloadLocations();
      } catch (err: unknown) {
        console.warn("[weather] location delete failed:", errMsg(err));
        setError("Location could not be removed.");
      }
    },
    [locations, reloadLocations],
  );

  const nowIso = forecast?.current?.time;
  const code = forecast?.current?.weather_code ?? 0;
  const visual = weatherVisual(code);
  const sunrise = forecast?.daily?.sunrise?.[0];
  const sunset = forecast?.daily?.sunset?.[0];
  const day = forecast?.current?.is_day != null
    ? forecast.current.is_day === 1
    : isDaytime(nowIso ?? new Date().toISOString(), sunrise, sunset);
  const gradient = day ? visual.gradientDay : visual.gradientNight;

  const hourly = useMemo(
    () => (forecast ? buildHourly(forecast, nowIso, 24) : []),
    [forecast, nowIso],
  );
  const daily = useMemo(() => (forecast ? buildDaily(forecast, 7) : []), [forecast]);
  const span = useMemo(() => tempSpan(daily), [daily]);

  const currentTemp = forecast?.current?.temperature_2m ?? 0;
  const feels = forecast?.current?.apparent_temperature ?? currentTemp;
  const todayDaily = daily[0];

  const hasLocations = locations.length > 0;

  return (
    <main className="weather-app" data-tone={visual.tone}>
      <aside className="sidebar">
        <header className="sidebar__head">
          <h1>Weather</h1>
          <button
            type="button"
            className="add-btn"
            aria-label="Add location"
            onClick={() => setSearchOpen(true)}
          >
            <Plus size={18} />
          </button>
        </header>

        <div className="location-list" role="list">
          {locations.map((loc) => {
            const id = loc.id ?? loc.name;
            const isActive = (active?.id ?? active?.name) === id;
            return (
              <button
                key={id}
                type="button"
                role="listitem"
                data-testid="location-item"
                className={isActive ? "loc-chip loc-chip--active" : "loc-chip"}
                onClick={() => setActiveId(id)}
              >
                <MapPin size={15} />
                <span className="loc-chip__name">{loc.name}</span>
                {loc.is_default ? <span className="loc-chip__badge">Default</span> : null}
                <span
                  className="loc-chip__remove"
                  role="button"
                  tabIndex={-1}
                  aria-label={`Remove ${loc.name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeLocation(loc);
                  }}
                >
                  <Trash2 size={14} />
                </span>
              </button>
            );
          })}
          {!hasLocations ? <p className="sidebar__hint">No saved places yet.</p> : null}
        </div>
      </aside>

      <section className="stage">
        {!hasLocations ? (
          <div className="empty-state" data-testid="empty-state">
            <div className="empty-state__mark">
              <WeatherIcon name="cloud-sun" size={40} />
            </div>
            <h2>Add your first location</h2>
            <p>Search any city to see live conditions, an hourly strip, and a 7-day forecast.</p>
            <button type="button" className="primary-action" onClick={() => setSearchOpen(true)}>
              <Search size={16} /> Search a city
            </button>
          </div>
        ) : (
          <div className="weather-scroll">
            <div className="hero" style={{ backgroundImage: gradient }} data-testid="weather-hero">
              <div className={`hero__sky hero__sky--${visual.kind}`} aria-hidden="true">
                <span className="hero__orb" />
                <span className="hero__cloud hero__cloud--a" />
                <span className="hero__cloud hero__cloud--b" />
              </div>
              <div className="hero__content">
                <div className="hero__loc" data-testid="hero-location">
                  <MapPin size={16} /> {active?.name ?? "—"}
                </div>
                <div className="hero__temp" data-testid="hero-temp">
                  {status === "loading" ? "—" : formatTemp(currentTemp, unit)}
                </div>
                <div className="hero__condition" data-testid="hero-condition">
                  <WeatherIcon name={visual.icon} size={22} /> {visual.label}
                </div>
                <div className="hero__meta">
                  <span>Feels {formatTemp(feels, unit)}</span>
                  {todayDaily ? (
                    <span>
                      H:{formatTemp(todayDaily.highC, unit)} · L:{formatTemp(todayDaily.lowC, unit)}
                    </span>
                  ) : null}
                </div>
                <div className="hero__chips">
                  {forecast?.current?.relative_humidity_2m != null ? (
                    <span className="hero__chip">
                      <Droplets size={13} /> {Math.round(forecast.current.relative_humidity_2m)}%
                    </span>
                  ) : null}
                  {forecast?.current?.wind_speed_10m != null ? (
                    <span className="hero__chip">
                      <Wind size={13} /> {Math.round(forecast.current.wind_speed_10m)} km/h
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className="unit-toggle"
                    onClick={() => setUnit((u) => (u === "c" ? "f" : "c"))}
                    aria-label="Toggle temperature unit"
                  >
                    °{unit === "c" ? "C" : "F"}
                  </button>
                </div>
              </div>
            </div>

            {status === "demo" ? (
              <div className="demo-notice" data-testid="demo-notice">
                Showing demo data — live forecast is unavailable right now.
              </div>
            ) : null}
            {error ? <div className="error-notice">{error}</div> : null}

            <div className="panel">
              <h3 className="panel__title">Hourly forecast</h3>
              <div className="hourly-strip" data-testid="hourly-strip">
                {hourly.map((h, i) => (
                  <div className="hourly-cell" data-testid="hourly-cell" key={`${h.time}-${i}`}>
                    <span className="hourly-cell__time">{formatHour(h.time, h.isNow)}</span>
                    <WeatherIcon name={weatherVisual(h.code).icon} size={20} />
                    <span className="hourly-cell__temp">{formatTemp(h.tempC, unit)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="panel">
              <h3 className="panel__title">7-day forecast</h3>
              <div className="daily-list" data-testid="daily-list">
                {daily.map((d) => {
                  const range = span.max - span.min || 1;
                  const left = ((d.lowC - span.min) / range) * 100;
                  const width = ((d.highC - d.lowC) / range) * 100;
                  return (
                    <div className="daily-row" data-testid="daily-row" key={d.date}>
                      <span className="daily-row__day">{formatDay(d.date, nowIso)}</span>
                      <span className="daily-row__icon">
                        <WeatherIcon name={weatherVisual(d.code).icon} size={20} />
                      </span>
                      <span className="daily-row__low">{formatTemp(d.lowC, unit)}</span>
                      <span className="daily-row__bar">
                        <span
                          className="daily-row__bar-fill"
                          style={{ left: `${left}%`, width: `${Math.max(8, width)}%` }}
                        />
                      </span>
                      <span className="daily-row__high">{formatTemp(d.highC, unit)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </section>

      {searchOpen ? (
        <div
          className="search-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Search locations"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setSearchOpen(false);
          }}
        >
          <div className="search-panel">
            <form
              className="search-bar"
              onSubmit={(e) => {
                e.preventDefault();
              }}
            >
              <Search size={18} />
              <input
                data-testid="search-input"
                autoFocus
                placeholder="Search city or place"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSearchOpen(false);
                }}
              />
              <button
                type="button"
                className="search-close"
                aria-label="Close search"
                onClick={() => setSearchOpen(false)}
              >
                <X size={16} />
              </button>
            </form>
            <div className="search-results">
              {searching ? <p className="search-hint">Searching…</p> : null}
              {!searching && searchError ? <p className="search-hint">{searchError}</p> : null}
              {results.map((r, i) => (
                <button
                  key={`${r.name}-${r.latitude}-${r.longitude}-${i}`}
                  type="button"
                  data-testid="search-result"
                  className="search-result"
                  onClick={() => void addLocation(r)}
                >
                  <MapPin size={15} />
                  <span className="search-result__name">{r.name}</span>
                  <span className="search-result__meta">
                    {[r.admin1, r.country].filter(Boolean).join(", ")}
                  </span>
                </button>
              ))}
              {!searching && !searchError && query.trim().length < 2 ? (
                <p className="search-hint">Type at least two characters.</p>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

// Re-export to keep DEMO_LOCATION referenced for tree-shake clarity / tooling.
export { DEMO_LOCATION };
