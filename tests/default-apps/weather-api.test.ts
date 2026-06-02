// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchForecast, geocode } from "../../home/apps/weather/src/weather-api";

describe("weather api proxy", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(window, "MatrixOS");
  });

  it("rejects proxy error payloads instead of treating them as forecast data", async () => {
    Object.defineProperty(window, "MatrixOS", {
      configurable: true,
      value: {
        proxyFetch: vi.fn(async () => ({ error: "upstream request failed" })),
      },
    });

    await expect(fetchForecast({
      name: "Berlin",
      latitude: 52.52,
      longitude: 13.405,
    })).rejects.toThrow("proxy request failed");
  });

  it("rejects empty proxy responses instead of treating them as forecast data", async () => {
    Object.defineProperty(window, "MatrixOS", {
      configurable: true,
      value: {
        proxyFetch: vi.fn(async () => null),
      },
    });

    await expect(fetchForecast({
      name: "Berlin",
      latitude: 52.52,
      longitude: 13.405,
    })).rejects.toThrow("proxy request failed: empty response");
  });

  it("drops blank geocode names before returning search results", async () => {
    Object.defineProperty(window, "MatrixOS", {
      configurable: true,
      value: {
        proxyFetch: vi.fn(async () => ({
          results: [
            { name: "", latitude: 52.52, longitude: 13.405 },
            { name: "  Berlin  ", latitude: 52.52, longitude: 13.405, country: "Germany" },
          ],
        })),
      },
    });

    await expect(geocode("Berlin")).resolves.toEqual([
      { name: "Berlin", latitude: 52.52, longitude: 13.405, country: "Germany", admin1: undefined },
    ]);
  });
});
