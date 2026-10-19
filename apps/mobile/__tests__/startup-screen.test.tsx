import React from "react";
import { render, screen } from "@testing-library/react-native";
import { ActivityIndicator, StyleSheet as NativeStyleSheet, Text, useColorScheme } from "react-native";
import type { UnistylesThemes } from "react-native-unistyles";

import { StartupLoading, StartupScreen } from "../components/StartupScreen";
import { useStartupColors } from "../lib/use-startup-colors";

type SplashPluginOptions = {
  image: string;
  imageWidth: number;
  backgroundColor: string;
  dark: { image: string; backgroundColor: string };
};

const appConfig = require("../app.json") as { expo: { plugins: (string | [string, unknown])[] } };
const unistyles = jest.requireMock<typeof import("react-native-unistyles")>("react-native-unistyles");

/** What the expo-splash-screen plugin draws natively before any JavaScript runs. */
function nativeSplash(): SplashPluginOptions {
  const plugin = appConfig.expo.plugins.find(
    (entry) => Array.isArray(entry) && entry[0] === "expo-splash-screen",
  );
  if (!Array.isArray(plugin)) throw new Error("app.json does not configure expo-splash-screen");
  return plugin[1] as SplashPluginOptions;
}

/** The themes the app registers, read back from its own Unistyles configuration. */
function loadAppThemes(): UnistylesThemes {
  let themes: UnistylesThemes | undefined;
  jest.isolateModules(() => {
    const { StyleSheet } = require("react-native-unistyles") as typeof import("react-native-unistyles");
    const configure = jest.spyOn(StyleSheet, "configure");
    require("../lib/unistyles");
    themes = configure.mock.calls[0]?.[0].themes;
  });
  if (!themes) throw new Error("lib/unistyles did not register its themes");
  return themes;
}

const appThemes = loadAppThemes();

type ColorMode = keyof UnistylesThemes;

/**
 * Launches with the device in one appearance and the app's theme, as picked in
 * Settings, possibly in the other. The Unistyles jest mock always serves the
 * light theme, so the named one is served instead.
 */
function launchWith({ device, appTheme }: { device: ColorMode; appTheme: ColorMode }) {
  // React Native's jest preset replaces useColorScheme with a mock pinned to light.
  jest.mocked(useColorScheme).mockReturnValue(device);
  jest.spyOn(unistyles, "useUnistyles").mockImplementation(
    () => ({ theme: appThemes[appTheme], rt: unistyles.UnistylesRuntime }) as ReturnType<typeof unistyles.useUnistyles>,
  );
}

/** Status content as the root layout hands it over: coloured for the startup screen's ground. */
function StatusMessage() {
  const colors = useStartupColors();
  return <Text style={{ color: colors.textSubtle }}>Authenticating…</Text>;
}

function colorOf(text: string): unknown {
  return NativeStyleSheet.flatten(screen.getByText(text).props.style).color;
}

describe("startup screen", () => {
  afterEach(() => {
    jest.mocked(useColorScheme).mockReturnValue("light");
    jest.restoreAllMocks();
  });

  it("shows the rabbit logo above the Matrix OS title and its status content", () => {
    render(
      <StartupScreen>
        <Text>Authenticating…</Text>
      </StartupScreen>,
    );

    expect(screen.getByLabelText("Matrix OS logo")).toBeTruthy();
    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("Authenticating…")).toBeTruthy();

    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf("startup-logo")).toBeGreaterThan(-1);
    expect(tree.indexOf("startup-logo")).toBeLessThan(tree.indexOf("Matrix OS\""));
    expect(tree.indexOf("Matrix OS\"")).toBeLessThan(tree.indexOf("Authenticating…"));
  });

  it("keeps the logo where the native splash screen draws it", () => {
    const { imageWidth } = nativeSplash();
    render(<StartupScreen />);

    // The native splash is a square image at the center of the screen. The logo
    // matches it, and everything else hangs below without taking part in the
    // centering, so the rabbit does not move when the splash hands over.
    expect(imageWidth).toBe(160);
    const logo = NativeStyleSheet.flatten(screen.getByTestId("startup-logo").props.style);
    expect(logo).toMatchObject({ width: imageWidth, height: imageWidth });
    const details = NativeStyleSheet.flatten(screen.getByTestId("startup-details").props.style);
    expect(details).toMatchObject({ position: "absolute", top: imageWidth });
  });

  it("repeats the light splash: the same artwork on the same ground", () => {
    const splash = nativeSplash();
    launchWith({ device: "light", appTheme: "light" });
    render(<StartupScreen />);

    expect(splash.image).toBe("./assets/splash-icon.png");
    expect(screen.getByTestId("startup-logo").props.source).toBe(require("../assets/splash-icon.png"));
    const ground = NativeStyleSheet.flatten(screen.getByTestId("startup-screen").props.style);
    expect(ground.backgroundColor).toBe(splash.backgroundColor);
  });

  it("repeats the dark splash, which has its own artwork and ground", () => {
    const splash = nativeSplash();
    launchWith({ device: "dark", appTheme: "dark" });
    render(<StartupScreen />);

    expect(splash.dark.image).toBe("./assets/splash-icon-dark.png");
    expect(screen.getByTestId("startup-logo").props.source).toBe(require("../assets/splash-icon-dark.png"));
    const ground = NativeStyleSheet.flatten(screen.getByTestId("startup-screen").props.style);
    expect(ground.backgroundColor).toBe(splash.dark.backgroundColor);
    expect(splash.dark.backgroundColor).not.toBe(splash.backgroundColor);
  });

  // The native splash is drawn for the device's appearance; it knows nothing of
  // the theme picked in Settings. The startup screen has to agree with it, or
  // the launch flips colours at the hand-over.
  it("stays on the dark splash on a dark device when Light is picked in Settings", () => {
    const splash = nativeSplash();
    launchWith({ device: "dark", appTheme: "light" });
    render(
      <StartupScreen>
        <StatusMessage />
      </StartupScreen>,
    );

    expect(screen.getByTestId("startup-logo").props.source).toBe(require("../assets/splash-icon-dark.png"));
    const ground = NativeStyleSheet.flatten(screen.getByTestId("startup-screen").props.style);
    expect(ground.backgroundColor).toBe(splash.dark.backgroundColor);
    // Text on it is the dark scheme's too, or it would be dark on dark.
    expect(colorOf("Matrix OS")).toBe(appThemes.dark.v2.colors.textDefault);
    expect(colorOf("Authenticating…")).toBe(appThemes.dark.v2.colors.textSubtle);
  });

  it("stays on the light splash on a light device when Dark is picked in Settings", () => {
    const splash = nativeSplash();
    launchWith({ device: "light", appTheme: "dark" });
    render(
      <StartupScreen>
        <StatusMessage />
      </StartupScreen>,
    );

    expect(screen.getByTestId("startup-logo").props.source).toBe(require("../assets/splash-icon.png"));
    const ground = NativeStyleSheet.flatten(screen.getByTestId("startup-screen").props.style);
    expect(ground.backgroundColor).toBe(splash.backgroundColor);
    expect(colorOf("Matrix OS")).toBe(appThemes.light.v2.colors.textDefault);
    expect(colorOf("Authenticating…")).toBe(appThemes.light.v2.colors.textSubtle);
  });

  it("leaves the title out until its font has loaded", () => {
    render(<StartupScreen showTitle={false} />);

    expect(screen.getByLabelText("Matrix OS logo")).toBeTruthy();
    expect(screen.queryByText("Matrix OS")).toBeNull();
  });

  it("waits on the same spinner in the same place, whatever it is waiting for", () => {
    render(<StartupLoading testID="first-wait" />);
    const first = screen.UNSAFE_getByType(ActivityIndicator);
    expect(first.props).toMatchObject({ size: "large", testID: "first-wait" });
    expect(NativeStyleSheet.flatten(first.props.style)).toMatchObject({ marginTop: 24 });
    expect(screen.getByTestId("startup-screen")).toBeTruthy();
    expect(screen.getByText("Matrix OS")).toBeTruthy();
  });

  it("can say what it is waiting for, above the spinner", () => {
    render(<StartupLoading message="Authenticating…" />);

    expect(screen.getByText("Authenticating…")).toBeTruthy();
    expect(screen.UNSAFE_getByType(ActivityIndicator)).toBeTruthy();
  });
});
