// Network layer for Open-Meteo. Apps run in a null-origin sandboxed iframe with
// CSP connect-src 'self', so we CANNOT fetch third-party APIs directly. We go
// through window.MatrixOS.proxyFetch, which forwards the request (via postMessage)
// to the shell, which calls the gateway's allowlisted /api/bridge/proxy endpoint.
import type { OpenMeteoForecast, SavedLocation } from "./weather-model";

export interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

async function proxyJson<T>(url: string): Promise<T> {
  const proxy = window.MatrixOS?.proxyFetch;
  if (!proxy) {
    // No bridge (e.g. unit tests / no shell): allow a direct fetch so tests can
    // mock global fetch. In the real shell proxyFetch is always present.
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`request failed: ${res.status}`);
    return (await res.json()) as T;
  }
  const data = await withTimeout(proxy(url), 12_000);
  if (data == null) {
    throw new Error("proxy request failed: empty response");
  }
  if (
    typeof data === "object" &&
    "error" in data
  ) {
    throw new Error("proxy request failed");
  }
  return data as T;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error("proxy request timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

export async function geocode(query: string): Promise<GeoResult[]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const data = await proxyJson<{ results?: GeoResult[] }>(url.toString());
  const results = Array.isArray(data.results) ? data.results : [];
  return results
    .filter(
      (r) =>
        typeof r.name === "string" &&
        r.name.trim().length > 0 &&
        Number.isFinite(r.latitude) &&
        Number.isFinite(r.longitude),
    )
    .map((r) => ({
      name: r.name.trim(),
      latitude: r.latitude,
      longitude: r.longitude,
      country: r.country,
      admin1: r.admin1,
    }));
}

export async function fetchForecast(loc: SavedLocation): Promise<OpenMeteoForecast> {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(loc.latitude));
  url.searchParams.set("longitude", String(loc.longitude));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,weather_code,is_day,relative_humidity_2m,wind_speed_10m",
  );
  url.searchParams.set("hourly", "temperature_2m,weather_code");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset");
  url.searchParams.set("forecast_days", "7");
  url.searchParams.set("timezone", "auto");

  return proxyJson<OpenMeteoForecast>(url.toString());
}
