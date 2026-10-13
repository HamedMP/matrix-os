const mockPush = jest.fn();
const mockNavigate = jest.fn();
const mockNavigation = { navigate: mockNavigate };
const mockUseComputerApps = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useNavigation: () => mockNavigation,
}));

jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => mockUseComputerApps(),
  installedAppSlug: (app: { file: string; path: string; name: string; slug: string }) => jest.requireActual("../lib/apps").getAppIdentity(app),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import AppsScreen from "../app/(drawer)/(tabs)/(apps)/apps";
import { Icon } from "../components/ui/Icon";
import { ItemRow } from "../components/ui/ItemRow";
import {
  ChatIcon,
  ConnectAppsIcon,
  FolderIcon,
  SettingsTabIcon,
  TerminalTabIcon,
} from "../components/ui/icons";

const DEFAULT_APPS = ["Chat", "Terminal", "Files", "Settings", "Connect Apps"];

/** Tile labels in the order the grid draws them. */
function tileNames(): string[] {
  return screen.getAllByLabelText(/^Open /).map((tile) => String(tile.props.accessibilityLabel).slice("Open ".length));
}

describe("drawer apps screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComputerApps.mockReturnValue({
      computer: { handle: "solar-vale" },
      apps: [
        {
          name: "Chess",
          category: "games",
          icon: "game-center",
          slug: "chess",
          file: "games/chess/index.html",
          path: "/files/apps/games/chess/index.html",
        },
        {
          name: "Notes",
          category: "productivity",
          icon: "notes",
          slug: "notes",
          file: "notes/index.html",
          path: "/files/apps/notes/index.html",
        },
      ],
      authorization: "Bearer clerk-token",
      gatewayUrl: "https://app.matrix-os.com/vm/solar-vale",
      isPending: false,
      isError: false,
    });
  });

  it("opens an app preview", () => {
    render(<AppsScreen />);

    const first = NativeStyleSheet.flatten(screen.getByLabelText("Open Chess").props.style);
    const second = NativeStyleSheet.flatten(screen.getByLabelText("Open Notes").props.style);
    expect(first.backgroundColor).toBe(second.backgroundColor);
    expect(first.borderColor).toBe(second.borderColor);

    fireEvent.press(screen.getByLabelText("Open Chess"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/app-preview/[app]",
      params: { app: "games/chess", runtimeSlug: "chess", name: "Chess" },
    });
  });

  it("lists the default apps first, in the desktop launcher's order, then the installed apps", () => {
    render(<AppsScreen />);

    expect(tileNames()).toEqual([...DEFAULT_APPS, "Notes", "Chess"]);
  });

  it("draws the grid under the search field instead of rows above it", () => {
    render(<AppsScreen />);

    const hosts = screen.root.findAll((node: { type: unknown }) => typeof node.type === "string");
    const search = hosts.indexOf(screen.getByLabelText("Search apps"));
    for (const name of [...DEFAULT_APPS, "Notes", "Chess"]) {
      expect(hosts.indexOf(screen.getByLabelText(`Open ${name}`))).toBeGreaterThan(search);
    }
    expect(screen.UNSAFE_queryAllByType(ItemRow)).toEqual([]);
  });

  it("draws each default app as the desktop launcher does: a white icon on its own colour", () => {
    render(<AppsScreen />);

    const artwork = (name: string) => {
      const tile = screen.getByTestId(`default-app-icon-${name}`);
      const icon = tile.findByType(Icon);
      return {
        backgroundColor: NativeStyleSheet.flatten(tile.props.style).backgroundColor,
        icon: icon.props.icon,
        color: icon.props.color,
      };
    };

    expect(artwork("Chat")).toEqual({ backgroundColor: "#BA5236", icon: ChatIcon, color: "white" });
    expect(artwork("Terminal")).toEqual({ backgroundColor: "#E0AA52", icon: TerminalTabIcon, color: "white" });
    expect(artwork("Files")).toEqual({ backgroundColor: "#748E59", icon: FolderIcon, color: "white" });
    expect(artwork("Settings")).toEqual({ backgroundColor: "#6B7280", icon: SettingsTabIcon, color: "white" });
    expect(artwork("Connect Apps")).toEqual({ backgroundColor: "#7C6DB4", icon: ConnectAppsIcon, color: "white" });
  });

  it("gives default and installed artwork the same footprint, so labels line up across a row", () => {
    render(<AppsScreen />);

    const footprint = (name: string) => {
      const { width, height } = NativeStyleSheet.flatten(screen.getByTestId(`app-logo-${name}`).props.style);
      return { width, height };
    };

    expect(footprint("Chat")).toEqual({ width: 68, height: 68 });
    expect(footprint("Connect Apps")).toEqual(footprint("Chess"));
  });

  it("opens Chat, Terminal and Settings on their own tabs", () => {
    render(<AppsScreen />);

    fireEvent.press(screen.getByLabelText("Open Chat"));
    expect(mockNavigate).toHaveBeenLastCalledWith("(tabs)", {
      screen: "(chats)",
      params: { screen: "index", pop: true },
    });

    fireEvent.press(screen.getByLabelText("Open Terminal"));
    expect(mockNavigate).toHaveBeenLastCalledWith("(tabs)", { screen: "terminal" });

    fireEvent.press(screen.getByLabelText("Open Settings"));
    expect(mockNavigate).toHaveBeenLastCalledWith("(tabs)", { screen: "settings" });

    expect(mockNavigate).toHaveBeenCalledTimes(3);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("opens Files and Connect Apps on top of the Apps tab", () => {
    render(<AppsScreen />);

    fireEvent.press(screen.getByLabelText("Open Files"));
    expect(mockPush).toHaveBeenLastCalledWith("/files");

    fireEvent.press(screen.getByLabelText("Open Connect Apps"));
    expect(mockPush).toHaveBeenLastCalledWith("/integrations");

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("opens a promoted default such as Notes as the installed app it is", () => {
    render(<AppsScreen />);

    fireEvent.press(screen.getByLabelText("Open Notes"));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: "/app-preview/[app]",
      params: { app: "notes", runtimeSlug: "notes", name: "Notes" },
    });
  });

  it("leaves out installed web apps that a default app replaces", () => {
    const state = mockUseComputerApps();
    mockUseComputerApps.mockReturnValue({
      ...state,
      apps: [
        { name: "Browser", slug: "browser", file: "browser/index.html", path: "/files/apps/browser/index.html" },
        ...state.apps,
        { name: "Terminal", slug: "terminal", file: "terminal/index.html", path: "/files/apps/terminal/index.html" },
      ],
    });

    render(<AppsScreen />);

    expect(tileNames()).toEqual([...DEFAULT_APPS, "Notes", "Chess"]);
  });

  it("keeps the default apps within reach while the installed apps load", () => {
    mockUseComputerApps.mockReturnValue({
      computer: undefined,
      apps: [],
      authorization: undefined,
      gatewayUrl: null,
      isPending: true,
      isError: false,
    });

    render(<AppsScreen />);

    expect(tileNames()).toEqual(DEFAULT_APPS);
    expect(screen.getAllByTestId("app-tile-skeleton")).toHaveLength(3);
    expect(screen.queryByText("No apps installed.")).toBeNull();
  });

  it("keeps the default apps within reach when the installed apps cannot be read", () => {
    mockUseComputerApps.mockReturnValue({ ...mockUseComputerApps(), isError: true });

    render(<AppsScreen />);

    expect(tileNames()).toEqual(DEFAULT_APPS);
    expect(screen.getByText("Apps unavailable. Try again.")).toBeTruthy();
    expect(screen.queryByTestId("app-tile-skeleton")).toBeNull();
  });

  it("says so when the computer has no web apps, under the default apps", () => {
    mockUseComputerApps.mockReturnValue({ ...mockUseComputerApps(), apps: [] });

    render(<AppsScreen />);

    expect(tileNames()).toEqual(DEFAULT_APPS);
    expect(screen.getByText("No apps installed.")).toBeTruthy();
  });

  it("starts below the status bar now that no navigator draws a header above it", () => {
    render(
      <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
        <AppsScreen />
      </SafeAreaInsetsContext.Provider>,
    );

    expect(NativeStyleSheet.flatten(screen.root.props.style)).toMatchObject({ flex: 1, paddingTop: 62 });
  });

  it("names the supported presentations for apps needing workspace capabilities", () => {
    render(<AppsScreen />);
    expect(screen.getByText("Apps that use workspace data or connected accounts may not work here yet. Open those apps on Web Canvas, Web Desktop or Electron Desktop.")).toBeTruthy();
  });

  it("filters default and installed apps by name", () => {
    render(<AppsScreen />);

    fireEvent.changeText(screen.getByLabelText("Search apps"), "note");

    expect(tileNames()).toEqual(["Notes"]);

    fireEvent.changeText(screen.getByLabelText("Search apps"), "SET");

    expect(tileNames()).toEqual(["Settings"]);

    fireEvent.press(screen.getByLabelText("Clear Search apps"));

    expect(tileNames()).toEqual([...DEFAULT_APPS, "Notes", "Chess"]);
    expect(screen.getByLabelText("Search apps").props.value).toBe("");
  });

  it("does not call the computer empty in the middle of a search", () => {
    mockUseComputerApps.mockReturnValue({ ...mockUseComputerApps(), apps: [] });
    render(<AppsScreen />);

    fireEvent.changeText(screen.getByLabelText("Search apps"), "chat");

    expect(tileNames()).toEqual(["Chat"]);
    expect(screen.queryByText("No apps installed.")).toBeNull();
  });

  it("says so when no app matches the search", () => {
    render(<AppsScreen />);

    fireEvent.changeText(screen.getByLabelText("Search apps"), "zzz");

    expect(screen.queryAllByLabelText(/^Open /)).toEqual([]);
    expect(screen.getByText("No matching apps.")).toBeTruthy();
    expect(screen.queryByText("No apps installed.")).toBeNull();
  });

  it("centers larger app artwork above the app name", () => {
    render(<AppsScreen />);

    expect(NativeStyleSheet.flatten(screen.getByLabelText("Open Chess").props.style)).toEqual(
      expect.objectContaining({
        flexDirection: "column",
        alignItems: "center",
        borderWidth: 0,
        backgroundColor: "transparent",
      }),
    );
    expect(NativeStyleSheet.flatten(screen.getByTestId("app-logo-Chess").props.style)).toEqual(
      expect.objectContaining({ width: 68, height: 68 }),
    );
    expect(screen.getAllByTestId("app-tile-artwork-label-spacer")[0].props.style).toEqual(
      expect.arrayContaining([expect.objectContaining({ height: 12 })]),
    );
  });

  it("uses spacers instead of vertical padding or margins", () => {
    render(<AppsScreen />);

    const styles = [
      screen.getByTestId("page-content").props.style,
      screen.getByTestId("page-heading").props.style,
      screen.getByLabelText("Search apps").props.style,
      screen.getByLabelText("Open Chess").props.style,
    ].map(NativeStyleSheet.flatten);

    for (const style of styles) {
      expect(style.paddingTop).toBeUndefined();
      expect(style.paddingBottom).toBeUndefined();
      expect(style.paddingVertical).toBeUndefined();
      expect(style.marginTop).toBeUndefined();
      expect(style.marginBottom).toBeUndefined();
      expect(style.marginVertical).toBeUndefined();
    }
  });
});
