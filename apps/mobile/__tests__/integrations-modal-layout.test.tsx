const mockDismiss = jest.fn();
const mockBack = jest.fn();
let mockScreenOptions: Record<string, unknown> | undefined;

jest.mock("expo-router", () => ({
  Stack: ({ screenOptions }: { screenOptions?: Record<string, unknown> }) => {
    mockScreenOptions = screenOptions;
    return null;
  },
  useRouter: () => ({ dismiss: mockDismiss, back: mockBack }),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import InstalledIntegrationsLayout from "../app/integrations-installed/_layout";
import IntegrationDetailLayout from "../app/integration-detail/_layout";

function renderIosHeaderItem() {
  const HeaderItems = mockScreenOptions?.unstable_headerLeftItems as (() => Array<{
    element: React.ReactNode;
    hidesSharedBackground?: boolean;
  }>) | undefined;
  const items = HeaderItems?.() ?? [];
  expect(items[0]?.hidesSharedBackground).toBe(true);
  render(<>{items[0]?.element}</>);
}

describe("integrations modal navigation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScreenOptions = undefined;
  });

  it("shows a transparent HugeIcons close control on installed integrations", () => {
    render(<InstalledIntegrationsLayout />);
    renderIosHeaderItem();

    const button = screen.getByLabelText("Close installed integrations");
    const style = NativeStyleSheet.flatten(button.props.style);
    expect(style.backgroundColor).toBe("transparent");
    expect(style.borderWidth).toBeUndefined();
    expect(screen.getByTestId("integrations-close-icon")).toBeTruthy();

    fireEvent.press(button);
    expect(mockDismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a transparent HugeIcons back control on integration details", () => {
    render(<IntegrationDetailLayout />);
    renderIosHeaderItem();

    const button = screen.getByLabelText("Back to integrations");
    const style = NativeStyleSheet.flatten(button.props.style);
    expect(style.backgroundColor).toBe("transparent");
    expect(style.borderWidth).toBeUndefined();
    expect(screen.getByTestId("integrations-back-icon")).toBeTruthy();

    fireEvent.press(button);
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
