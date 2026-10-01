// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AOEDE_PREFERENCES_STORAGE_KEY,
  loadAoedePreferences,
  saveAoedePreferences,
} from "../../packages/ui/src/aoede/preferences.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("aoede preferences", () => {
  it("returns defaults when nothing is stored or storage is absent", () => {
    expect(loadAoedePreferences()).toEqual({});
    vi.stubGlobal("window", undefined);
    expect(() => loadAoedePreferences()).not.toThrow();
    expect(loadAoedePreferences()).toEqual({});
    expect(() => saveAoedePreferences({ turnMode: "push_to_talk" })).not.toThrow();
  });

  it("round-trips turn mode and device selections", () => {
    saveAoedePreferences({ turnMode: "push_to_talk", inputDeviceId: "mic_usb", outputDeviceId: "spk_hdmi" });
    expect(loadAoedePreferences()).toEqual({
      turnMode: "push_to_talk",
      inputDeviceId: "mic_usb",
      outputDeviceId: "spk_hdmi",
    });
    saveAoedePreferences({ turnMode: "hands_free", inputDeviceId: null });
    expect(loadAoedePreferences()).toEqual({ turnMode: "hands_free", inputDeviceId: null });
  });

  it("drops malformed, oversized, and strict-shape-violating values without throwing", () => {
    window.localStorage.setItem(AOEDE_PREFERENCES_STORAGE_KEY, "not json {");
    expect(loadAoedePreferences()).toEqual({});

    window.localStorage.setItem(AOEDE_PREFERENCES_STORAGE_KEY, JSON.stringify({ turnMode: "always_on" }));
    expect(loadAoedePreferences()).toEqual({});

    window.localStorage.setItem(AOEDE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      turnMode: "push_to_talk",
      extra: "injected",
    }));
    expect(loadAoedePreferences()).toEqual({});

    window.localStorage.setItem(AOEDE_PREFERENCES_STORAGE_KEY, "x".repeat(5_000));
    expect(loadAoedePreferences()).toEqual({});

    window.localStorage.setItem(AOEDE_PREFERENCES_STORAGE_KEY, JSON.stringify({
      inputDeviceId: "m".repeat(300),
    }));
    expect(loadAoedePreferences()).toEqual({});
  });

  it("never throws when storage itself rejects reads or writes", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(loadAoedePreferences()).toEqual({});
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    expect(() => saveAoedePreferences({ turnMode: "hands_free" })).not.toThrow();
  });

  it("bounds written payloads and ignores writes that cannot normalize", () => {
    expect(() => saveAoedePreferences({ inputDeviceId: "x".repeat(300) })).not.toThrow();
    expect(window.localStorage.getItem(AOEDE_PREFERENCES_STORAGE_KEY)).toBeNull();
  });
});
