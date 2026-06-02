// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../home/apps/weather/src/App";

type DbRow = Record<string, unknown>;

function installMatrixDb(initialRows: DbRow[] = []) {
  const rows = [...initialRows];
  let changeHandler: (() => void) | null = null;
  let insertCount = 0;
  const db = {
    find: vi.fn(async () => rows),
    findOne: vi.fn(async () => null),
    insert: vi.fn(async (_table: string, data: DbRow) => {
      const id = `loc-new-${++insertCount}`;
      rows.push({ id, ...data });
      changeHandler?.();
      return { id };
    }),
    update: vi.fn(async (_table: string, id: string, data: DbRow) => {
      const row = rows.find((item) => item.id === id);
      if (row) Object.assign(row, data);
      changeHandler?.();
      return { ok: true };
    }),
    delete: vi.fn(async (_table: string, id: string) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index >= 0) rows.splice(index, 1);
      changeHandler?.();
      return { ok: true };
    }),
    count: vi.fn(async () => rows.length),
    onChange: vi.fn((_table: string, callback: () => void) => {
      changeHandler = callback;
      return () => {
        changeHandler = null;
      };
    }),
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: { db } });
  return db;
}

function installMatrixDataBridge(data = new Map<string, unknown>()) {
  const bridge = {
    readData: vi.fn(async (key: string) => data.get(key) ?? null),
    writeData: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
  };
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: bridge });
  return bridge;
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

  it("converts wind speed to mph when Fahrenheit is selected", async () => {
    installMatrixDb([
      { id: "loc-1", name: "Berlin", latitude: 52.52, longitude: 13.405, is_default: true },
    ]);
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);

    await vi.waitFor(() => {
      expect(screen.getByText("11 km/h")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: /toggle temperature unit/i }));

    expect(screen.getByText("7 mph")).toBeTruthy();
    expect(screen.queryByText("11 km/h")).toBeNull();
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
    expect(typeof payload.created_at).toBe("string");
    expect(Number.isNaN(Date.parse(payload.created_at as string))).toBe(false);

    db.insert.mockClear();
    fireEvent.click(screen.getByRole("button", { name: /add location/i }));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "Berlin" } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-result"));

    expect(db.insert).not.toHaveBeenCalled();
    expect(screen.getAllByTestId("location-item")).toHaveLength(1);
  });

  it("rolls back optimistic add when DB insert fails", async () => {
    const db = installMatrixDb([]);
    db.insert.mockRejectedValueOnce(new Error("insert failed"));
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /search a city/i }));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "Berlin" } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-result"));

    await vi.waitFor(() => {
      expect(screen.getByText(/location could not be saved/i)).toBeTruthy();
    });
    expect(screen.getByTestId("empty-state")).toBeTruthy();
  });

  it("rolls back optimistic remove when DB delete fails", async () => {
    const db = installMatrixDb([
      { id: "loc-1", name: "Berlin", latitude: 52.52, longitude: 13.405, is_default: true },
    ]);
    db.delete.mockRejectedValueOnce(new Error("delete failed"));
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getAllByText("Berlin").length).toBeGreaterThan(0);
    });

    const removeButton = screen.getByRole("button", { name: /remove berlin/i });
    expect(removeButton.getAttribute("tabindex")).not.toBe("-1");
    fireEvent.click(removeButton);

    await vi.waitFor(() => {
      expect(screen.getByText(/location could not be removed/i)).toBeTruthy();
    });
    expect(screen.getAllByText("Berlin").length).toBeGreaterThan(0);
  });

  it("promotes the next location when removing the default", async () => {
    const db = installMatrixDb([
      { id: "loc-1", name: "Berlin", latitude: 52.52, longitude: 13.405, is_default: true },
      { id: "loc-2", name: "Paris", latitude: 48.8566, longitude: 2.3522, is_default: false },
    ]);
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getAllByText("Berlin").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Paris").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: /remove berlin/i }));

    await vi.waitFor(() => {
      expect(db.delete).toHaveBeenCalledWith("locations", "loc-1");
      expect(db.update).toHaveBeenCalledWith("locations", "loc-2", { is_default: true });
    });
    const parisItem = screen.getAllByTestId("location-item").find((item) =>
      within(item).queryByText("Paris"),
    );
    expect(parisItem).toBeTruthy();
    expect(within(parisItem as HTMLElement).getByText("Default")).toBeTruthy();
  });

  it("stores fallback locations through MatrixOS data bridge", async () => {
    const bridge = installMatrixDataBridge();
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /search a city/i }));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "Berlin" } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-result"));

    await vi.waitFor(() => {
      expect(bridge.writeData.mock.calls.some(([key]) => key === "matrix-weather-locations")).toBe(true);
    });
    const stored = bridge.writeData.mock.calls.find(([key]) => key === "matrix-weather-locations")?.[1] as Array<Record<string, unknown>>;
    expect(stored).toEqual([expect.objectContaining({ name: "Berlin" })]);
    expect(String(stored[0].id ?? "")).not.toMatch(/^local-/);
  });

  it("does not persist duplicates or optimistic local ids when adding fallback locations repeatedly", async () => {
    const bridge = installMatrixDataBridge();
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByTestId("empty-state")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /search a city/i }));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "Berlin" } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-result"));

    await vi.waitFor(() => {
      const stored = bridge.writeData.mock.calls.find(
        ([key]) => key === "matrix-weather-locations",
      )?.[1] as Array<Record<string, unknown>> | undefined;
      expect(stored?.length).toBe(1);
    });

    fireEvent.click(screen.getByRole("button", { name: /add location/i }));
    fireEvent.change(screen.getByTestId("search-input"), { target: { value: "Berlin" } });
    await vi.advanceTimersByTimeAsync(400);
    await vi.waitFor(() => {
      expect(screen.getByTestId("search-result")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-result"));

    await vi.waitFor(() => {
      const writes = bridge.writeData.mock.calls.filter(
        ([key]) => key === "matrix-weather-locations",
      );
      const stored = writes.at(-1)?.[1] as Array<Record<string, unknown>> | undefined;
      expect(stored?.length).toBe(1);
      expect(stored?.some((loc) => String(loc.id ?? "").startsWith("local-"))).toBe(false);
    });
  });

  it("strips optimistic local ids when removing fallback locations", async () => {
    const bridge = installMatrixDataBridge(new Map<string, unknown>([[
      "matrix-weather-locations",
      [
        { id: "local-stale", name: "Paris", latitude: 48.8566, longitude: 2.3522 },
        { id: "stored-berlin", name: "Berlin", latitude: 52.52, longitude: 13.405, is_default: true },
      ],
    ]]));
    globalThis.fetch = mockFetchOk() as unknown as typeof fetch;

    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getAllByText("Berlin").length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /remove berlin/i }));

    await vi.waitFor(() => {
      const writes = bridge.writeData.mock.calls.filter(
        ([key]) => key === "matrix-weather-locations",
      );
      const stored = writes.at(-1)?.[1] as Array<Record<string, unknown>> | undefined;
      expect(stored).toEqual([expect.objectContaining({ name: "Paris" })]);
      expect(stored?.some((loc) => String(loc.id ?? "").startsWith("local-"))).toBe(false);
    });
  });
});
