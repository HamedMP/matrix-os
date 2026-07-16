jest.mock("@/app/_layout", () => ({
  useGateway: () => ({ connectionState: "connected" }),
}));

jest.mock("expo-blur", () => ({
  BlurView: () => null,
}));

const registeredScreens: Array<{ name: string; options?: Record<string, unknown> }> = [];

jest.mock("expo-router", () => {
  const React = require("react");
  function Tabs({ children }: { children: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children);
  }
  Tabs.Screen = ({ name, options }: { name: string; options?: Record<string, unknown> }) => {
    registeredScreens.push({ name, options });
    return null;
  };
  return { Tabs };
});

import React from "react";
import { render } from "@testing-library/react-native";
import TabsLayout from "../app/(tabs)/_layout";

describe("tabs layout", () => {
  beforeEach(() => {
    registeredScreens.length = 0;
  });

  it("shows Chat as a visible bottom tab", () => {
    render(<TabsLayout />);

    const chat = registeredScreens.find((screen) => screen.name === "chat");
    expect(chat).toBeDefined();
    expect(chat?.options?.href).not.toBeNull();
    expect(chat?.options?.title).toBe("Chat");
    expect(chat?.options?.tabBarIcon).toBeDefined();
  });

  it("keeps Apps as the landing tab and hides retired routes", () => {
    render(<TabsLayout />);

    const names = registeredScreens.map((screen) => screen.name);
    expect(names).toEqual(expect.arrayContaining(["apps", "chat", "terminal", "settings"]));

    const missionControl = registeredScreens.find((screen) => screen.name === "mission-control");
    expect(missionControl?.options?.href).toBeNull();
  });
});
