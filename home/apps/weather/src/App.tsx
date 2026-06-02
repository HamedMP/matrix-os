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
  dailyTemperatureBar,
  DEMO_LOCATION,
  demoForecast,
  formatDay,
  formatHour,
  formatTemp,
  formatWindSpeed,
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
const LOCATIONS_KEY = "matrix-weather-locations";
const UNIT_KEY = "matrix-weather-unit";
const MAX_PENDING_REMOVALS = 50;

type LoadStatus = "loading" | "live" | "demo";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const fallbackData: Record<string, unknown> = {};

async function readAppData<T>(key: string, fallback: T): Promise<T> {
  try {
    if (window.MatrixOS?.readData) {
      const value = await window.MatrixOS.readData(key);
      return value === undefined || value === null ? fallback : (value as T);
    }
  } catch (err: unknown) {
    console.warn("[weather] app data read failed:", errMsg(err));
  }
  return Object.prototype.hasOwnProperty.call(fallbackData, key) ? (fallbackData[key] as T) : fallback;
}

async function writeAppData<T>(key: string, value: T): Promise<void> {
  try {
    if (window.MatrixOS?.writeData) {
      await window.MatrixOS.writeData(key, value);
      return;
    }
  } catch (err: unknown) {
    console.warn("[weather] app data write failed:", errMsg(err));
  }
  fallbackData[key] = value;
}

async function readStoredLocations(): Promise<SavedLocation[]> {
  const parsed = await readAppData<unknown>(LOCATIONS_KEY, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(coerceLocation).filter((l): l is SavedLocation => l !== null);
}

function locationKey(loc: SavedLocation): string {
  return loc.id ?? `${loc.name}:${loc.latitude}:${loc.longitude}`;
}

function sameCoordinates(a: Pick<SavedLocation, "latitude" | "longitude">, b: Pick<SavedLocation, "latitude" | "longitude">): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

function stripLocalId(loc: SavedLocation): SavedLocation {
  if (!loc.id?.startsWith("local-")) return loc;
  return {
    name: loc.name,
    latitude: loc.latitude,
    longitude: loc.longitude,
    is_default: loc.is_default,
  };
}

function storedLocations(locations: SavedLocation[]): SavedLocation[] {
  return locations.map(stripLocalId);
}

function sameLocations(a: SavedLocation[], b: SavedLocation[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((loc, index) => {
    const other = b[index];
    return (
      !!other &&
      locationKey(loc) === locationKey(other) &&
      loc.name === other.name &&
      loc.latitude === other.latitude &&
      loc.longitude === other.longitude &&
      loc.is_default === other.is_default
    );
  });
}

function planLocationRemoval(locations: SavedLocation[], key: string, wasDefault: boolean) {
  const remaining = locations.filter((l) => locationKey(l) !== key);
  const shouldPromoteDefault = wasDefault && !remaining.some((l) => l.is_default);
  const nextLocations = shouldPromoteDefault && remaining[0]
    ? remaining.map((item, index) => index === 0 ? { ...item, is_default: true } : item)
    : remaining;
  const promotedKey = shouldPromoteDefault && remaining[0] ? locationKey(remaining[0]) : null;
  return { nextLocations, promotedKey };
}

function usePendingLocationOps() {
  const removalKeys = useRef<string[]>([]);
  const defaultPromotionKeys = useRef<Set<string>>(new Set());

  return useMemo(() => ({
    hiddenRemovalKeys: () => removalKeys.current,
    markRemoved: (key: string) => {
      removalKeys.current = [...removalKeys.current.filter((k) => k !== key), key].slice(-MAX_PENDING_REMOVALS);
    },
    clearRemoved: (...keys: string[]) => {
      const cleared = new Set(keys);
      removalKeys.current = removalKeys.current.filter((k) => !cleared.has(k));
    },
    isRemoved: (key: string) => removalKeys.current.includes(key),
    markDefaultPromotion: (key: string) => {
      defaultPromotionKeys.current.add(key);
    },
    clearDefaultPromotion: (key: string) => {
      defaultPromotionKeys.current.delete(key);
    },
    consumeDefaultPromotion: (key: string) => {
      const marked = defaultPromotionKeys.current.has(key);
      if (marked) defaultPromotionKeys.current.delete(key);
      return marked;
    },
  }), []);
}

export default function App() {
  const [locations, setLocations] = useState<SavedLocation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [forecast, setForecast] = useState<OpenMeteoForecast | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [unit, setUnit] = useState<Unit>("c");
  const [unitReady, setUnitReady] = useState(false);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchSeq = useRef(0);
  const pendingLocations = usePendingLocationOps();

  const reloadLocations = useCallback(async () => {
    const db = window.MatrixOS?.db;
    if (!db) {
      const stored = await readStoredLocations();
      setLocations((current) => (sameLocations(current, stored) ? current : stored));
      setError(null);
      return;
    }
    try {
      const rows = await db.find(LOCATIONS_TABLE, { orderBy: { created_at: "asc" } });
      const parsed = rows
        .map(coerceLocation)
        .filter((l): l is SavedLocation => l !== null)
        .filter((l) => !pendingLocations.hiddenRemovalKeys().includes(locationKey(l)));
      setLocations((current) => (sameLocations(current, parsed) ? current : parsed));
      setError(null);
    } catch (err: unknown) {
      console.warn("[weather] location load failed:", errMsg(err));
      setError("Saved locations could not be loaded.");
      const stored = await readStoredLocations();
      setLocations((current) => (sameLocations(current, stored) ? current : stored));
    }
  }, [pendingLocations]);

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
    let cancelled = false;
    void readAppData<Unit>(UNIT_KEY, "c").then((stored) => {
      if (cancelled) return;
      setUnit(stored === "f" ? "f" : "c");
      setUnitReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!unitReady) return;
    void writeAppData(UNIT_KEY, unit);
  }, [unit, unitReady]);

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

  const activeForecastLocation = useMemo<SavedLocation | null>(() => {
    if (!active) return null;
    return {
      name: active.name,
      latitude: active.latitude,
      longitude: active.longitude,
    };
  }, [active?.name, active?.latitude, active?.longitude]);

  // Load forecast for the active location with graceful demo fallback.
  useEffect(() => {
    if (!activeForecastLocation) {
      setForecast(null);
      setStatus("loading");
      return;
    }
    let cancelled = false;
    setStatus("loading");
    (async () => {
      try {
        const data = await fetchForecast(activeForecastLocation);
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
  }, [activeForecastLocation]);

  // Debounced geocode search.
  useEffect(() => {
    if (!searchOpen) return undefined;
    const q = query.trim();
    const seq = ++searchSeq.current;
    if (q.length < 2) {
      setResults([]);
      setSearchError(null);
      setSearching(false);
      return undefined;
    }
    setSearching(false);
    setSearchError(null);
    const handle = window.setTimeout(async () => {
      setSearching(true);
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
      const previousActiveId = activeId;
      const duplicate = locations.find((loc) => sameCoordinates(loc, geo));
      if (duplicate) {
        setActiveId(duplicate.id ?? duplicate.name);
        setSearchOpen(false);
        setQuery("");
        setResults([]);
        setSearchError(null);
        return;
      }
      const label = geo.admin1 && geo.admin1 !== geo.name ? `${geo.name}, ${geo.admin1}` : geo.name;
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
        const existing = await readStoredLocations();
        await writeAppData(LOCATIONS_KEY, storedLocations([...existing, candidate]));
        setError(null);
        return;
      }
      try {
        const { id } = await db.insert(LOCATIONS_TABLE, {
          name: candidate.name,
          latitude: candidate.latitude,
          longitude: candidate.longitude,
          is_default: candidate.is_default ?? false,
          created_at: new Date().toISOString(),
        });
        if (pendingLocations.isRemoved(optimistic.id!)) {
          try {
            await db.delete(LOCATIONS_TABLE, id);
            setError(null);
          } catch (err: unknown) {
            console.warn("[weather] pending removed location cleanup failed:", errMsg(err));
            setError("Location could not be removed.");
          } finally {
            pendingLocations.clearRemoved(optimistic.id!, id);
            pendingLocations.clearDefaultPromotion(optimistic.id!);
          }
          await reloadLocations();
          return;
        }
        let savedIsDefault = candidate.is_default ?? false;
        let promotionFailed = false;
        if (pendingLocations.consumeDefaultPromotion(optimistic.id!)) {
          try {
            await db.update(LOCATIONS_TABLE, id, { is_default: true });
            savedIsDefault = true;
          } catch (err: unknown) {
            promotionFailed = true;
            console.warn("[weather] default location promotion failed:", errMsg(err));
          }
        }
        const saved: SavedLocation = { ...candidate, id, is_default: savedIsDefault };
        setLocations((curr) => {
          const savedKey = locationKey(saved);
          if (curr.some((loc) => locationKey(loc) === optimistic.id)) {
            return curr.map((loc) => (locationKey(loc) === optimistic.id ? saved : loc));
          }
          if (curr.some((loc) => locationKey(loc) === savedKey)) {
            return curr.map((loc) => (locationKey(loc) === savedKey ? { ...loc, ...saved } : loc));
          }
          return [...curr, saved];
        });
        setActiveId(id);
        await reloadLocations();
        setError(promotionFailed ? "Default location could not be updated." : null);
      } catch (err: unknown) {
        console.warn("[weather] location save failed:", errMsg(err));
        setError("Location could not be saved.");
        setLocations((curr) => curr.filter((loc) => locationKey(loc) !== optimistic.id));
        setActiveId(previousActiveId);
        pendingLocations.clearRemoved(optimistic.id!);
        pendingLocations.clearDefaultPromotion(optimistic.id!);
      }
    },
    [activeId, locations, pendingLocations, reloadLocations],
  );

  const removeLocation = useCallback(
    async (loc: SavedLocation) => {
      const previousLocations = locations;
      const previousActiveId = activeId;
      const key = locationKey(loc);
      pendingLocations.markRemoved(key);
      const { nextLocations, promotedKey } = planLocationRemoval(locations, key, loc.is_default === true);
      if (promotedKey?.startsWith("local-")) {
        pendingLocations.markDefaultPromotion(promotedKey);
      }
      setLocations(nextLocations);
      const db = window.MatrixOS?.db;
      if (!db) {
        await writeAppData(LOCATIONS_KEY, storedLocations(nextLocations));
        pendingLocations.clearRemoved(key);
        setError(null);
        return;
      }
      if (!loc.id || loc.id.startsWith("local-")) {
        pendingLocations.clearDefaultPromotion(key);
        return;
      }
      try {
        await db.delete(LOCATIONS_TABLE, loc.id);
      } catch (err: unknown) {
        pendingLocations.clearRemoved(key);
        if (promotedKey) pendingLocations.clearDefaultPromotion(promotedKey);
        console.warn("[weather] location delete failed:", errMsg(err));
        setError("Location could not be removed.");
        setLocations(previousLocations);
        setActiveId(previousActiveId);
        return;
      }
      let promotionFailed = false;
      const promoted = promotedKey ? nextLocations[0] : null;
      if (promoted?.id && !promoted.id.startsWith("local-")) {
        try {
          await db.update(LOCATIONS_TABLE, promoted.id, { is_default: true });
        } catch (err: unknown) {
          promotionFailed = true;
          console.warn("[weather] default location promotion failed:", errMsg(err));
        }
      }
      if (promotedKey && !promotedKey.startsWith("local-")) {
        pendingLocations.clearDefaultPromotion(promotedKey);
      }
      pendingLocations.clearRemoved(key);
      await reloadLocations();
      setError(promotionFailed ? "Default location could not be updated." : null);
    },
    [activeId, locations, pendingLocations, reloadLocations],
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
              <div
                key={id}
                role="listitem"
                data-testid="location-item"
                className={isActive ? "loc-chip loc-chip--active" : "loc-chip"}
              >
                <button
                  type="button"
                  className="loc-chip__select"
                  onClick={() => setActiveId(id)}
                >
                  <MapPin size={15} />
                  <span className="loc-chip__name">{loc.name}</span>
                  {loc.is_default ? <span className="loc-chip__badge">Default</span> : null}
                </button>
                <button
                  type="button"
                  className="loc-chip__remove"
                  aria-label={`Remove ${loc.name}`}
                  onClick={() => void removeLocation(loc)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
          {!hasLocations ? <p className="sidebar__hint">No saved places yet.</p> : null}
        </div>
      </aside>

      <section className="stage">
        {error ? <div className="error-notice">{error}</div> : null}
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
                      <Wind size={13} /> {formatWindSpeed(forecast.current.wind_speed_10m, unit)}
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
                  const bar = dailyTemperatureBar(d, span);
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
                          style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
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
