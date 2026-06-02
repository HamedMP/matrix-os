// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchForecast } from "../../home/apps/weather/src/weather-api";

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
});
