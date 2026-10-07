let mockApp = "notes";
jest.mock("@/components/edition/edition-screen", () => {
  const { Text } = require("react-native");
  return () => <Text>Trusted Edition reader</Text>;
});
const mockUseComputerAppSession = jest.fn();

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ app: mockApp, name: "Notes" }),
}));

jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerAppSession: () => mockUseComputerAppSession(),
}));

jest.mock("@/components/AppRuntimeFrame", () => {
  const { Text } = require("react-native");
  return function MockAppRuntimeFrame({
    url,
    title,
  }: {
    url: string;
    title: string;
  }) {
    return <Text>{`${title}:${url}`}</Text>;
  };
});

import React from "react";
import { render, screen } from "@testing-library/react-native";

import AppPreviewScreen from "../app/app-preview/[app]";

describe("app preview screen", () => {
  it("renders the authenticated runtime session fullscreen", () => {
    mockUseComputerAppSession.mockReturnValue({
      launchUrl: "https://app.matrix-os.com/apps/notes/?session=session-token",
      isPending: false,
      isError: false,
    });

    render(<AppPreviewScreen />);

    expect(
      screen.getByText(
        "Notes:https://app.matrix-os.com/apps/notes/?session=session-token",
      ),
    ).toBeTruthy();
    expect(screen.getByTestId("app-preview-runtime").props.style).toEqual(
      expect.objectContaining({ flex: 1 }),
    );
  });
});

it("routes Edition to the trusted native reader without creating an app session", () => {
  mockApp = "edition";
  mockUseComputerAppSession.mockClear();
  render(<AppPreviewScreen />);
  expect(screen.getByText("Trusted Edition reader")).toBeTruthy();
  expect(mockUseComputerAppSession).not.toHaveBeenCalled();
  mockApp = "notes";
});
