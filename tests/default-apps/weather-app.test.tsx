// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/weather/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(rows: DbRow[] = []) {
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async () => ({ id: "loc-new" })),
    update: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(async () => ({ ok: true })),
    count: vi.fn(async () => rows.length),
    onChange: vi.fn(() => () => undefined),
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: { db } });
  return db;
}

const FORECAST_JSON = {
  current: {
    time: "2026-05-31T10:00:00",
    temperature_2m: 18.4,
    apparent_temperature: 16.9,
    weather_code: 2,
    is_day: 1,
    relative_humidity_2m: 70,
    wind_speed_10m: 11,
  },
  hourly: {
    time: Array.from({ length: 24 }, (_, i) => `2026-05-31T${String(i).padStart(2, "0")}:00:00`),
    temperature_2m: Array.from({ length: 24 }, (_, i) => 12 + i * 0.3),
    weather_code: Array.from({ length: 24 }, () => 2),
  },
  daily: {
    time: ["2026-05-31", "2026-06-01", "2026-06-02"],
    weather_code: [2, 61, 0],
    temperature_2m_max: [21, 18, 24],
    temperature_2m_min: [11, 9, 13],
    sunrise: ["2026-05-31T06:00:00"],
    sunset: ["2026-05-31T20:00:00"],
  },
};

const GEOCODE_JSON = {
  results: [
    { name: "Berlin", latitude: 52.52, longitude: 13.405, country: "Germany", admin1: "Berlin" },
  ],
};

function mockFetchOk() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url.includes("geocoding-api") ? GEOCODE_JSON : FORECAST_JSON;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as Response;
  });
}

describe("Weather app", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-31T10:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
    Reflect.deleteProperty(globalThis, "fetch");
    window.localStorage.clear();
  });

  it("loads a default location and renders the hero, hourly strip, and daily forecast", async () => {
    installMatrixDb([
      { id: "loc-1", name: "Berlin", latitude: 52.52, longitude: 13.405, is_default: true },
    ]);
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);

    await vi.waitFor(() => {
      expect(screen.getByTestId("hero-temp").textContent).toBe("18°");
    });
    // condition label from code 2 → Partly Cloudy
    expect(screen.getByTestId("hero-condition").textContent).toContain("Partly Cloudy");
    // current location name
    expect(screen.getByTestId("hero-location").textContent).toContain("Berlin");

    // hourly strip rendered with at least several hours
    const hourly = screen.getByTestId("hourly-strip");
    expect(within(hourly).getAllByTestId("hourly-cell").length).toBeGreaterThan(5);
    expect(within(hourly).getByText("Now")).toBeTruthy();

    // daily forecast rendered with our 3 days
    const daily = screen.getByTestId("daily-list");
    expect(within(daily).getAllByTestId("daily-row").length).toBe(3);
  });

  it("falls back to seeded demo data with a notice when fetch fails", async () => {
    installMatrixDb([
      { id: "loc-1", name: "Berlin", latitude: 52.52, longitude: 13.405, is_default: true },
    ]);
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    render(<App />);

    await vi.waitFor(() => {
      expect(screen.getByTestId("demo-notice")).toBeTruthy();
    });
    // still shows a hero (never a blank screen)
    expect(screen.getByTestId("hero-temp")).toBeTruthy();
    const hourly = screen.getByTestId("hourly-strip");
    expect(within(hourly).getAllByTestId("hourly-cell").length).toBeGreaterThan(5);
  });

  it("searches and saves a new location via the DB bridge", async () => {
    const db = installMatrixDb([]);
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);

    // empty state onboarding when no locations
    await vi.waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeTruthy();
    });

    // open the search overlay from the empty-state CTA
    fireEvent.click(screen.getByRole("button", { name: /search a city/i }));

    const input = screen.getByTestId("search-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Berlin" } });
    // advance the debounce timer so geocode fires
    await vi.advanceTimersByTimeAsync(400);

    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-result"));

    await vi.waitFor(() => {
      expect(db.insert).toHaveBeenCalled();
    });
    const [table, payload] = db.insert.mock.calls[0];
    expect(table).toBe("locations");
    expect(payload).toMatchObject({ name: "Berlin", latitude: 52.52, longitude: 13.405 });
  });
});
