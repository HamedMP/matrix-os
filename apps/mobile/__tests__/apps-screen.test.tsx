const mockPush = jest.fn();
const mockUseComputerApps = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerApps: () => mockUseComputerApps(),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import AppsScreen from "../app/(drawer)/apps";

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
      params: { app: "chess", name: "Chess" },
    });
  });

  it("filters installed apps by name", () => {
    render(<AppsScreen />);

    fireEvent.changeText(screen.getByLabelText("Search apps"), "note");

    expect(screen.getByLabelText("Open Notes")).toBeTruthy();
    expect(screen.queryByLabelText("Open Chess")).toBeNull();

    fireEvent.press(screen.getByLabelText("Clear Search apps"));

    expect(screen.getByLabelText("Open Chess")).toBeTruthy();
    expect(screen.getByLabelText("Search apps").props.value).toBe("");
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
