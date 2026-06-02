import { describe, expect, it } from "vitest";
import {
  buildDaily,
  buildHourly,
  coerceLocation,
  dailyTemperatureBar,
  demoForecast,
  formatDay,
  formatHour,
  formatTemp,
  isDaytime,
  tempSpan,
  toUnit,
  weatherVisual,
  type OpenMeteoForecast,
} from "../../home/apps/weather/src/weather-model";

describe("weatherVisual code mapping", () => {
  it("maps clear sky", () => {
    const v = weatherVisual(0);
    expect(v.label).toBe("Clear Sky");
    expect(v.kind).toBe("clear");
    expect(v.icon).toBe("sun");
    expect(v.gradientDay).toContain("linear-gradient");
    expect(v.gradientNight).toContain("linear-gradient");
  });

  it("maps rain and snow and thunder families", () => {
    expect(weatherVisual(63).kind).toBe("rain");
    expect(weatherVisual(75).kind).toBe("snow");
    expect(weatherVisual(75).tone).toBe("dark");
    expect(weatherVisual(95).kind).toBe("thunder");
    expect(weatherVisual(45).kind).toBe("fog");
    expect(weatherVisual(45).tone).toBe("dark");
    expect(weatherVisual(51).kind).toBe("drizzle");
    expect(weatherVisual(3).kind).toBe("cloudy");
  });

  it("falls back gracefully for unknown codes", () => {
    const v = weatherVisual(1234);
    expect(v.label).toBe("Unknown");
    expect(v.icon).toBe("cloud");
  });
});

describe("temperature formatting", () => {
  it("rounds celsius", () => {
    expect(formatTemp(14.6, "c")).toBe("15°");
    expect(formatTemp(-0.4, "c")).toBe("0°");
  });

  it("converts to fahrenheit", () => {
    expect(Math.round(toUnit(0, "f"))).toBe(32);
    expect(Math.round(toUnit(100, "f"))).toBe(212);
    expect(formatTemp(20, "f")).toBe("68°");
  });

  it("handles non-finite input", () => {
    expect(toUnit(Number.NaN, "c")).toBe(0);
  });
});

describe("hour and day labels", () => {
  it("labels now and pm/am", () => {
    expect(formatHour("2026-05-31T15:00:00", true)).toBe("Now");
    expect(formatHour("2026-05-31T15:00:00")).toBe("3 PM");
    expect(formatHour("2026-05-31T00:00:00")).toBe("12 AM");
    expect(formatHour("2026-05-31T09:00:00")).toBe("9 AM");
  });

  it("labels today vs weekday", () => {
    const today = "2026-05-31T10:00:00";
    expect(formatDay("2026-05-31", today)).toBe("Today");
    expect(formatDay("2026-06-01", today)).toBe("Mon");
  });

  it("compares Open-Meteo date-only days without timezone rollover", () => {
    expect(formatDay("2026-06-01", "2026-06-01T00:30:00-07:00")).toBe("Today");
  });

  it("compares timestamp days by date prefix when today has an offset", () => {
    expect(formatDay("2026-06-01T00:30:00", "2026-06-01T00:30:00-07:00")).toBe("Today");
  });
});

describe("isDaytime", () => {
  it("uses sunrise/sunset window when given", () => {
    const sunrise = "2026-05-31T06:00:00.000Z";
    const sunset = "2026-05-31T20:00:00.000Z";
    expect(isDaytime("2026-05-31T12:00:00.000Z", sunrise, sunset)).toBe(true);
    expect(isDaytime("2026-05-31T22:00:00.000Z", sunrise, sunset)).toBe(false);
  });
});

const FORECAST: OpenMeteoForecast = {
  current: { time: "2026-05-31T10:00:00", temperature_2m: 18, weather_code: 2 },
  hourly: {
    time: [
      "2026-05-31T09:00:00",
      "2026-05-31T10:00:00",
      "2026-05-31T11:00:00",
      "2026-05-31T12:00:00",
    ],
    temperature_2m: [16, 18, 19, 20],
    weather_code: [3, 2, 1, 0],
  },
  daily: {
    time: ["2026-05-31", "2026-06-01", "2026-06-02"],
    weather_code: [2, 61, 0],
    temperature_2m_max: [21, 18, 24],
    temperature_2m_min: [11, 9, 13],
  },
};

describe("buildHourly", () => {
  it("starts at the slot at/after now and marks it", () => {
    const hours = buildHourly(FORECAST, "2026-05-31T10:00:00", 10);
    expect(hours[0].time).toBe("2026-05-31T10:00:00");
    expect(hours[0].isNow).toBe(true);
    expect(hours[1].isNow).toBe(false);
    expect(hours).toHaveLength(3);
  });

  it("returns empty when no hourly data", () => {
    expect(buildHourly({}, "2026-05-31T10:00:00")).toEqual([]);
  });
});

describe("buildDaily + tempSpan", () => {
  it("builds day points", () => {
    const days = buildDaily(FORECAST, 7);
    expect(days).toHaveLength(3);
    expect(days[1]).toMatchObject({ date: "2026-06-01", highC: 18, lowC: 9, code: 61 });
  });

  it("computes span across days", () => {
    const span = tempSpan(buildDaily(FORECAST));
    expect(span.min).toBe(9);
    expect(span.max).toBe(24);
  });

  it("keeps minimum daily bar width inside the track", () => {
    const bar = dailyTemperatureBar(
      { date: "2026-06-03", highC: 39, lowC: 38, code: 0 },
      { min: 25, max: 39 },
    );
    expect(bar.width).toBe(8);
    expect(bar.left + bar.width).toBeLessThanOrEqual(100);
    expect(bar.left).toBe(92);
  });
});

describe("coerceLocation", () => {
  it("accepts a valid row", () => {
    expect(coerceLocation({ name: "Paris", latitude: 48.85, longitude: 2.35 })).toMatchObject({
      name: "Paris",
      latitude: 48.85,
      longitude: 2.35,
    });
  });

  it("rejects invalid rows", () => {
    expect(coerceLocation(null)).toBeNull();
    expect(coerceLocation({ name: "", latitude: 1, longitude: 1 })).toBeNull();
    expect(coerceLocation({ name: "X", latitude: 200, longitude: 1 })).toBeNull();
    expect(coerceLocation({ name: "X", latitude: 1, longitude: "abc" })).toBeNull();
    expect(coerceLocation({ name: "Null Island", latitude: null, longitude: 0 })).toBeNull();
    expect(coerceLocation({ name: "Null Island", latitude: 0, longitude: null })).toBeNull();
  });
});

describe("demoForecast", () => {
  it("produces 24 hourly and 7 daily points anchored to base", () => {
    const f = demoForecast("2026-05-31T10:00:00");
    expect(f.hourly?.time).toHaveLength(24);
    expect(f.daily?.time).toHaveLength(7);
    expect(typeof f.current?.temperature_2m).toBe("number");
    const hours = buildHourly(f, "2026-05-31T10:00:00");
    expect(hours[0].isNow).toBe(true);
  });

  it("uses local Open-Meteo timestamp strings instead of UTC strings", () => {
    const f = demoForecast("2026-05-31T00:30:00+14:00");
    expect(f.current?.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00$/);
    expect(f.current?.time).not.toContain("Z");
    expect(f.hourly?.time?.[0]).not.toContain("Z");
    expect(f.daily?.time?.[0]).toBe(f.current?.time?.slice(0, 10));
    expect(f.daily?.sunrise?.[0]).not.toContain("Z");
    expect(formatDay(f.daily?.time?.[0] ?? "", f.current?.time)).toBe("Today");
  });
});
