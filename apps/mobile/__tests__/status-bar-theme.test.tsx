const mockUseAuth = jest.fn();
let mockOpenScreen: ReactNode = null;

jest.mock("expo-router", () => {
  // Only the root navigator lists its screens as children, so only it shows
  // the screen a test has open; a screen's own navigator renders nothing.
  function Stack({ children }: { children?: ReactNode }) {
    return children ? mockOpenScreen : null;
  }
  Stack.Screen = function Screen() {
    return null;
  };
  return {
    Stack,
    useRouter: () => ({ navigate: jest.fn(), dismiss: jest.fn() }),
    usePathname: () => "/",
  };
});

jest.mock("@clerk/clerk-expo", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockUseAuth(),
}));

jest.mock("expo-splash-screen", () => ({
  preventAutoHideAsync: jest.fn(() => Promise.resolve(true)),
  hideAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock("@expo-google-fonts/inter", () => ({ useFonts: () => [true] }));

jest.mock("react-native-gesture-handler", () => {
  const { View } = require("react-native");
  return { GestureHandlerRootView: View };
});

jest.mock("react-native-webview", () => {
  const mockReact = require("react");
  const { View } = require("react-native");
  const WebView = mockReact.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    mockReact.useImperativeHandle(ref, () => ({ injectJavaScript: jest.fn() }));
    return mockReact.createElement(View, { ...props, testID: "webview" });
  });
  // The app preview imports the default export, the terminal the named one.
  return { __esModule: true, default: WebView, WebView };
});

import React, { type ReactNode, useSyncExternalStore } from "react";
import { act, render, screen, type RenderAPI } from "@testing-library/react-native";
import { Appearance, NativeModules, type ColorSchemeName } from "react-native";
import type { UnistylesThemes } from "react-native-unistyles";
import * as SecureStore from "expo-secure-store";

import TerminalSessionLayout from "../app/terminal-session/_layout";
import AppRuntimeFrame from "../components/AppRuntimeFrame";
import { TerminalSurface } from "../components/TerminalSurface";
import { saveSettings } from "../lib/storage";
import { mobileQueryClient } from "../lib/query-client";
import { applyMobileThemePreference } from "../lib/theme-preference";

type ThemeName = keyof UnistylesThemes;
type AppearanceListener = (preferences: { colorScheme: ColorSchemeName }) => void;

const unistyles = jest.requireMock<typeof import("react-native-unistyles")>("react-native-unistyles");
const nativeStatusBar = NativeModules.StatusBarManager as { setStyle: jest.Mock };

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
const secureStoreItems = new Map<string, string>();
const themeReaders = new Set<() => void>();
const appearanceListeners = new Set<AppearanceListener>();
let activeTheme: ThemeName = "light";
let systemAppearance: ColorSchemeName = "light";
let app: RenderAPI | null = null;

function subscribeToTheme(notify: () => void) {
  themeReaders.add(notify);
  return () => {
    themeReaders.delete(notify);
  };
}

function setSystemAppearance(colorScheme: ColorSchemeName) {
  systemAppearance = colorScheme;
  act(() => {
    for (const listener of appearanceListeners) listener({ colorScheme });
  });
}

/** As the theme sheet in Settings does once the choice is saved. */
function chooseThemeInSettings(theme: "light" | "dark" | "system") {
  act(() => applyMobileThemePreference(theme));
}

function loadRootLayout() {
  // The publishable key is read once at module load, so set it before the
  // first require of the layout.
  process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY = "pk_test_status_bar";
  return (require("../app/_layout") as typeof import("../app/_layout")).default;
}

/** Lets the launch chain finish: the stored theme preference, Clerk, the biometric gate. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function launchApp() {
  const RootLayout = loadRootLayout();
  app = render(<RootLayout />);
  await settle();
}

/** Puts a screen on top of the root navigator, or takes it away again with null. */
async function showScreen(content: ReactNode) {
  const RootLayout = loadRootLayout();
  mockOpenScreen = content;
  app?.rerender(<RootLayout />);
  await settle();
}

/**
 * The content style the device was last told to draw. React Native sends it
 * once per frame, after merging every mounted status bar.
 */
async function statusBarContent(): Promise<string | undefined> {
  await settle();
  return nativeStatusBar.setStyle.mock.lastCall?.[0];
}

describe("status bar content", () => {
  beforeEach(() => {
    mockOpenScreen = null;
    app = null;
    activeTheme = "light";
    systemAppearance = "light";
    appearanceListeners.clear();
    secureStoreItems.clear();
    (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => secureStoreItems.get(key) ?? null);
    (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => {
      secureStoreItems.set(key, value);
    });
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
      userId: null,
      getToken: jest.fn(async () => null),
    });

    jest.spyOn(Appearance, "getColorScheme").mockImplementation(() => systemAppearance);
    jest.spyOn(Appearance, "addChangeListener").mockImplementation((listener) => {
      appearanceListeners.add(listener);
      return { remove: () => appearanceListeners.delete(listener) } as ReturnType<typeof Appearance.addChangeListener>;
    });

    // The Unistyles jest mock always serves the first registered theme and
    // ignores setTheme. Serve the theme that was last set, and re-render its
    // readers, as the native runtime does.
    jest.spyOn(unistyles.UnistylesRuntime, "setTheme").mockImplementation((name) => {
      activeTheme = name;
      for (const notify of themeReaders) notify();
    });
    jest.spyOn(unistyles, "useUnistyles").mockImplementation(() => {
      const name = useSyncExternalStore(subscribeToTheme, () => activeTheme);
      return { theme: appThemes[name], rt: unistyles.UnistylesRuntime } as ReturnType<typeof unistyles.useUnistyles>;
    });
  });

  afterEach(() => {
    // Nothing unmounts a rendered tree between tests here, and a status bar
    // left mounted keeps its say in the next test's merged style.
    app?.unmount();
    // Unmount schedules the real QueryClient's five-minute cache GC timers.
    // This suite owns the rendered root and must dispose its cached queries.
    mobileQueryClient.clear();
    expect(mobileQueryClient.getQueryCache().getAll()).toHaveLength(0);
    jest.restoreAllMocks();
  });

  describe("across the app", () => {
    it("is dark on the light theme", async () => {
      await launchApp();

      expect(await statusBarContent()).toBe("dark-content");
    });

    it("is light on the dark theme", async () => {
      systemAppearance = "dark";

      await launchApp();

      expect(await statusBarContent()).toBe("light-content");
    });

    it("follows the system appearance while the theme preference is System", async () => {
      await launchApp();

      setSystemAppearance("dark");
      expect(await statusBarContent()).toBe("light-content");

      setSystemAppearance("light");
      expect(await statusBarContent()).toBe("dark-content");
    });

    it("turns light when Dark is chosen in Settings on a device in light appearance", async () => {
      await launchApp();

      chooseThemeInSettings("dark");

      expect(await statusBarContent()).toBe("light-content");
    });

    it("turns dark when Light is chosen in Settings on a device in dark appearance", async () => {
      systemAppearance = "dark";
      await launchApp();

      chooseThemeInSettings("light");

      expect(await statusBarContent()).toBe("dark-content");
    });

    it("keeps a theme chosen in Settings when the system appearance changes", async () => {
      await launchApp();
      chooseThemeInSettings("dark");

      setSystemAppearance("dark");
      setSystemAppearance("light");

      expect(await statusBarContent()).toBe("light-content");
    });

    it("starts from the theme saved in Settings on the next launch", async () => {
      await saveSettings({ theme: "dark" });

      await launchApp();

      expect(await statusBarContent()).toBe("light-content");
    });

    it("is themed on the launch screens shown before the shell is up", async () => {
      // Clerk has not loaded, so the app is still on its startup screen.
      mockUseAuth.mockReturnValue({
        isLoaded: false,
        isSignedIn: false,
        userId: null,
        getToken: jest.fn(async () => null),
      });
      await saveSettings({ theme: "dark" });

      await launchApp();

      expect(await statusBarContent()).toBe("light-content");
    });
  });

  describe("on the terminal session screen", () => {
    it("stays light on the light theme, because the terminal surface is always dark", async () => {
      await launchApp();

      await showScreen(<TerminalSessionLayout />);

      expect(await statusBarContent()).toBe("light-content");
    });

    it("stays light on the dark theme", async () => {
      await launchApp();
      chooseThemeInSettings("dark");

      await showScreen(<TerminalSessionLayout />);

      expect(await statusBarContent()).toBe("light-content");
    });

    it("stays light when the theme changes while the terminal is open", async () => {
      systemAppearance = "dark";
      await launchApp();
      await showScreen(<TerminalSessionLayout />);

      setSystemAppearance("light");

      expect(await statusBarContent()).toBe("light-content");
    });

    it("goes back to the themed content when the terminal closes", async () => {
      await launchApp();
      await showScreen(<TerminalSessionLayout />);

      await showScreen(null);

      expect(await statusBarContent()).toBe("dark-content");
    });

    it("stays light when the app opens straight into a terminal session", async () => {
      mockOpenScreen = <TerminalSessionLayout />;

      await launchApp();

      expect(await statusBarContent()).toBe("light-content");
    });
  });

  // On iOS a WebView remembers the status bar style it found when it was
  // created and puts it back whenever any window shows or hides -- the
  // keyboard, a system prompt, the system changing appearance -- undoing a
  // style the app has set since. Both of the app's WebViews opt out.
  describe("under the app's web views", () => {
    it("is left alone by the app preview", () => {
      app = render(<AppRuntimeFrame url="https://app.matrix-os.com/apps/notes/?session=token" title="Notes" />);

      expect(screen.getByTestId("webview").props.autoManageStatusBarEnabled).toBe(false);
    });

    it("is left alone by the terminal", () => {
      app = render(<TerminalSurface fontScale={1} onInput={jest.fn()} onBinary={jest.fn()} onResize={jest.fn()} />);

      expect(screen.getByTestId("webview").props.autoManageStatusBarEnabled).toBe(false);
    });
  });
});
