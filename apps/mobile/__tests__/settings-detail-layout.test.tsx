const mockBack = jest.fn();
const mockScreens: { name: string; options: Record<string, unknown> }[] = [];

jest.mock("expo-router", () => {
  function Stack({ children }: { children?: React.ReactNode }) {
    return children ?? null;
  }
  Stack.Screen = function Screen({ name, options }: { name: string; options: Record<string, unknown> }) {
    mockScreens.push({ name, options });
    return null;
  };
  return { Stack, useRouter: () => ({ back: mockBack, dismiss: jest.fn() }) };
});

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

import SettingsDetailLayout from "../app/settings-detail/_layout";

function headerButton(name: string) {
  const options = mockScreens.find((entry) => entry.name === name)?.options;
  const headerLeft = options?.headerLeft as (() => React.ReactElement) | undefined;
  if (!headerLeft) throw new Error(`No header button on ${name}`);
  return headerLeft();
}

describe("settings pages", () => {
  beforeEach(() => {
    mockScreens.length = 0;
    mockBack.mockClear();
  });

  it("go back to Settings from a back arrow, as a page pushed from it", () => {
    render(<SettingsDetailLayout />);
    const pages = ["system", "account", "app-settings", "billing", "help"];
    const buttons = pages.map(headerButton);
    mockScreens.length = 0;
    render(<>{buttons}</>);

    const backs = screen.getAllByLabelText("Back to settings");
    expect(backs).toHaveLength(pages.length);
    fireEvent.press(backs[0]!);
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Close settings")).toBeNull();
  });

  it("keeps the back of the pages opened from another page", () => {
    render(<SettingsDetailLayout />);
    const buttons = ["support", "delete-account"].map(headerButton);
    mockScreens.length = 0;
    render(<>{buttons}</>);

    expect(screen.getByLabelText("Back to help")).toBeTruthy();
    expect(screen.getByLabelText("Back")).toBeTruthy();
  });
});
