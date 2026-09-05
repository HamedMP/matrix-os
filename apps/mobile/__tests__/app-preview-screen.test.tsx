const mockUseComputerAppSession = jest.fn();

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ app: "notes", name: "Notes" }),
}));

jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerAppSession: () => mockUseComputerAppSession(),
}));

jest.mock("@/components/AppRuntimeFrame", () => {
  const { Text } = require("react-native");
  return function MockAppRuntimeFrame({ url, title }: { url: string; title: string }) {
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

    expect(screen.getByText(
      "Notes:https://app.matrix-os.com/apps/notes/?session=session-token",
    )).toBeTruthy();
    expect(screen.getByTestId("app-preview-runtime").props.style).toEqual(
      expect.objectContaining({ flex: 1 }),
    );
  });
});
