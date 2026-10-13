import React from "react";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet, Text } from "react-native";
import type { UnistylesThemes } from "react-native-unistyles";

import { StartupScreen } from "../components/StartupScreen";

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

/** The Unistyles jest mock always serves the light theme; serve the named one instead. */
function useAppTheme(name: keyof UnistylesThemes) {
  jest.spyOn(unistyles, "useUnistyles").mockImplementation(
    () => ({ theme: appThemes[name], rt: unistyles.UnistylesRuntime }) as ReturnType<typeof unistyles.useUnistyles>,
  );
}

describe("startup screen", () => {
  afterEach(() => {
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
    useAppTheme("light");
    render(<StartupScreen />);

    expect(splash.image).toBe("./assets/splash-icon.png");
    expect(screen.getByTestId("startup-logo").props.source).toBe(require("../assets/splash-icon.png"));
    const ground = NativeStyleSheet.flatten(screen.getByTestId("startup-screen").props.style);
    expect(ground.backgroundColor).toBe(splash.backgroundColor);
  });

  it("repeats the dark splash, which has its own artwork and ground", () => {
    const splash = nativeSplash();
    useAppTheme("dark");
    render(<StartupScreen />);

    // A dark-green rabbit would vanish on the dark ground, and the app's own
    // dark background is not the splash's, so both have to follow the splash.
    expect(splash.dark.image).toBe("./assets/splash-icon-dark.png");
    expect(screen.getByTestId("startup-logo").props.source).toBe(require("../assets/splash-icon-dark.png"));
    const ground = NativeStyleSheet.flatten(screen.getByTestId("startup-screen").props.style);
    expect(ground.backgroundColor).toBe(splash.dark.backgroundColor);
    expect(splash.dark.backgroundColor).not.toBe(splash.backgroundColor);
  });

  it("leaves the title out until its font has loaded", () => {
    render(<StartupScreen showTitle={false} />);

    expect(screen.getByLabelText("Matrix OS logo")).toBeTruthy();
    expect(screen.queryByText("Matrix OS")).toBeNull();
  });
});
