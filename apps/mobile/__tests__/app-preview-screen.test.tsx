const mockUseComputerAppSession = jest.fn();
let mockApp = "notes";
let mockRuntimeSlug: string | undefined;

jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ app: mockApp, name: "Notes", runtimeSlug: mockRuntimeSlug }),
}));

jest.mock("@/lib/queries/use-computer-apps", () => ({
  useComputerAppSession: (app: string, runtimeSlug?: string) => mockUseComputerAppSession(app, runtimeSlug),
}));

jest.mock("@/components/AppRuntimeFrame", () => {
  const { Text } = require("react-native");
  return function MockAppRuntimeFrame({ url, title, app, runtimeSlug }: { url: string; title: string; app: string; runtimeSlug: string }) {
    return <Text testID="bound-app" accessibilityLabel={app} accessibilityHint={runtimeSlug}>{`${title}:${url}`}</Text>;
  };
});

import React from "react";
import { render, screen } from "@testing-library/react-native";

import AppPreviewScreen from "../app/app-preview/[app]";

describe("app preview screen", () => {
  beforeEach(() => { mockApp = "notes"; mockRuntimeSlug = undefined; jest.clearAllMocks(); });
  it("renders the authenticated runtime session fullscreen", () => {
    mockUseComputerAppSession.mockReturnValue({
      launchUrl: "https://app.matrix-os.com/apps/notes/?session=session-token",
      isPending: false,
      isError: false,
      appIdentity: "notes",
      runtimeSlug: "notes",
    });

    render(<AppPreviewScreen />);

    expect(screen.getByText(
      "Notes:https://app.matrix-os.com/apps/notes/?session=session-token",
    )).toBeTruthy();
    expect(screen.getByTestId("app-preview-runtime").props.style).toEqual(
      expect.objectContaining({ flex: 1 }),
    );
  });

  it("passes the nested installed identity into the native frame even when its runtime URL has a leaf slug", () => {
    mockApp = "games/chess";
    mockUseComputerAppSession.mockReturnValue({ launchUrl: "https://app.matrix-os.com/apps/chess/?session=fixture", appIdentity: "games/chess", runtimeSlug: "chess", isPending: false, isError: false });
    render(<AppPreviewScreen />);
    expect(mockUseComputerAppSession).toHaveBeenCalledWith("games/chess", undefined);
    expect(screen.getByTestId("bound-app").props.accessibilityLabel).toBe("games/chess");
  });

  it("uses the verified catalog pair returned by the session flow for an arbitrary nested app", () => {
    mockApp = "tools/timer"; mockRuntimeSlug = "timer";
    mockUseComputerAppSession.mockReturnValue({ launchUrl: "https://app.matrix-os.com/apps/timer/?session=fixture", appIdentity: "tools/timer", runtimeSlug: "timer", isPending: false, isError: false });
    render(<AppPreviewScreen />);
    expect(mockUseComputerAppSession).toHaveBeenCalledWith("tools/timer", "timer");
    expect(screen.getByTestId("bound-app").props.accessibilityLabel).toBe("tools/timer");
    expect(screen.getByTestId("bound-app").props.accessibilityHint).toBe("timer");
  });
});
