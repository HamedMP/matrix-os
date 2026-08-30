const registeredScreens: Array<{ name: string; options?: Record<string, unknown> }> = [];
let drawerScreenOptions: Record<string, unknown> | undefined;

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("expo-router/drawer", () => {
  const React = require("react");
  function Drawer({ children, screenOptions }: { children: React.ReactNode; screenOptions?: Record<string, unknown> }) {
    drawerScreenOptions = screenOptions;
    return React.createElement(React.Fragment, null, children);
  }
  Drawer.Screen = ({ name, options }: { name: string; options?: Record<string, unknown> }) => {
    registeredScreens.push({ name, options });
    return null;
  };
  return {
    Drawer,
    DrawerContentScrollView: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";
import DrawerLayout from "../app/(drawer)/_layout";
import { MockDrawerContent } from "../components/mock-shell/MockDrawerContent";

describe("authenticated drawer layout", () => {
  beforeEach(() => {
    registeredScreens.length = 0;
    drawerScreenOptions = undefined;
  });

  it("uses chat as home and exposes the five mock shell domains", () => {
    render(<DrawerLayout />);

    expect(registeredScreens.map((screen) => screen.name)).toEqual([
      "index",
      "search",
      "files",
      "terminal",
      "integrations",
      "apps",
    ]);
    expect(drawerScreenOptions?.drawerStyle).toMatchObject({ width: "84%" });
  });

  it("organizes the drawer as identity, natural-height navigation, and recent chats", () => {
    const navigate = jest.fn();
    const closeDrawer = jest.fn();

    render(
      <MockDrawerContent
        {...({
          state: {
            index: 0,
            routeNames: ["index", "search", "files", "terminal", "integrations", "apps"],
          },
          navigation: { navigate, closeDrawer },
          descriptors: {},
        } as never)}
      />,
    );

    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("solar-vale")).toBeTruthy();
    expect(screen.getByText("RECENTS")).toBeTruthy();
    expect(screen.queryByLabelText("Switch computer")).toBeNull();

    const filesStyle = NativeStyleSheet.flatten(screen.getByLabelText("Files").props.style);
    expect(filesStyle).toMatchObject({ borderWidth: 1 });
    expect(filesStyle.marginHorizontal).toBeUndefined();
    expect(filesStyle.height).toBeUndefined();
    expect(filesStyle.minHeight).toBeUndefined();

    const recentStyle = NativeStyleSheet.flatten(screen.getByLabelText("Open recent chat matrix-os").props.style);
    expect(recentStyle).toMatchObject({ borderWidth: 1 });
    expect(recentStyle.height).toBeUndefined();
    expect(recentStyle.minHeight).toBeUndefined();

    const recentsTitleStyle = NativeStyleSheet.flatten(screen.getByText("RECENTS").props.style);
    expect(recentsTitleStyle.paddingHorizontal).toBe(0);

    const newChatStyle = NativeStyleSheet.flatten(screen.getByLabelText("New chat").props.style);
    expect(newChatStyle).toMatchObject({
      position: "absolute",
      left: 16,
      bottom: 24,
      backgroundColor: "#2B3715",
      boxShadow: "0 8px 16px rgba(51, 46, 36, 0.10)",
    });
    expect(screen.getByTestId("icon-pencil-outline")).toBeTruthy();

    fireEvent.press(screen.getByLabelText("Search"));
    expect(navigate).toHaveBeenCalledWith("search");
    expect(closeDrawer).toHaveBeenCalled();
  });
});
