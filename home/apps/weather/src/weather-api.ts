// Network layer for Open-Meteo. Every fetch uses AbortSignal.timeout(10000).
import type { OpenMeteoForecast, SavedLocation } from "./weather-model";

const TIMEOUT_MS = 10_000;

export interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

export async function geocode(query: string): Promise<GeoResult[]> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`geocode failed: ${res.status}`);
  }
  const data = (await res.json()) as { results?: GeoResult[] };
  const results = Array.isArray(data.results) ? data.results : [];
  return results
    .filter(
      (r) =>
        typeof r.name === "string" &&
        Number.isFinite(r.latitude) &&
        Number.isFinite(r.longitude),
    )
    .map((r) => ({
      name: r.name,
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

  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`forecast failed: ${res.status}`);
  }
  return (await res.json()) as OpenMeteoForecast;
}
