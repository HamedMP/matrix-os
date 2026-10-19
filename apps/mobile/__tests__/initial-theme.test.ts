import * as SecureStore from "expo-secure-store";
import { Appearance } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { SETTINGS_KEY, initialMobileTheme } from "../lib/initial-theme";

const readSaved = jest.mocked(SecureStore.getItem);

function saved(settings: unknown) {
  readSaved.mockReturnValue(typeof settings === "string" ? settings : JSON.stringify(settings));
}

describe("the theme the first frame is drawn in", () => {
  let appearance: jest.SpyInstance;

  beforeEach(() => {
    readSaved.mockReset();
    appearance = jest.spyOn(Appearance, "getColorScheme").mockReturnValue("light");
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("is the theme chosen in Settings, read before anything is drawn", () => {
    saved({ theme: "dark", biometricEnabled: false });

    expect(initialMobileTheme()).toBe("dark");
    expect(readSaved).toHaveBeenCalledWith(SETTINGS_KEY);

    saved({ theme: "light" });
    appearance.mockReturnValue("dark");
    expect(initialMobileTheme()).toBe("light");
  });

  it("follows the device when the setting says so, or when nothing was saved", () => {
    saved({ theme: "system" });
    appearance.mockReturnValue("dark");
    expect(initialMobileTheme()).toBe("dark");

    readSaved.mockReturnValue(null);
    expect(initialMobileTheme()).toBe("dark");

    appearance.mockReturnValue(null);
    expect(initialMobileTheme()).toBe("light");
  });

  it("follows the device when the saved settings cannot be read", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    appearance.mockReturnValue("dark");

    saved("{not json");
    expect(initialMobileTheme()).toBe("dark");
    saved({ theme: "sepia" });
    expect(initialMobileTheme()).toBe("dark");
    readSaved.mockImplementation(() => { throw new TypeError("keychain locked"); });
    expect(initialMobileTheme()).toBe("dark");

    expect(warn).toHaveBeenCalledWith("[mobile] saved theme unreadable at launch", "TypeError");
  });

  it("is what the app's styles start in", () => {
    let settings: { initialTheme?: unknown } | undefined;
    let first: unknown;
    jest.isolateModules(() => {
      // The modules loaded here are fresh copies, the secure store's mock included.
      const store = require("expo-secure-store") as typeof SecureStore;
      jest.mocked(store.getItem).mockReturnValue(JSON.stringify({ theme: "dark" }));
      const configure = jest.spyOn(StyleSheet, "configure");
      require("../lib/unistyles");
      settings = configure.mock.calls[0]?.[0].settings as typeof settings;
      first = typeof settings?.initialTheme === "function" ? (settings.initialTheme as () => string)() : settings?.initialTheme;
    });

    expect(typeof settings?.initialTheme).toBe("function");
    expect(first).toBe("dark");
  });
});
