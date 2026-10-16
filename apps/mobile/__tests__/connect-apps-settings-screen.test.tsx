const mockPush = jest.fn();
const mockDismiss = jest.fn();
const mockBack = jest.fn();
const mockUseComputerIntegrations = jest.fn();
const mockScreens: Record<string, { options?: Record<string, unknown> }> = {};

jest.mock("expo-router", () => {
  const Stack = ({ children }: { children?: React.ReactNode }) => children ?? null;
  Stack.Screen = function MockStackScreen(props: { name: string; options?: Record<string, unknown> }) {
    mockScreens[props.name] = props;
    return null;
  };
  return {
    Stack,
    useRouter: () => ({ push: mockPush, dismiss: mockDismiss, back: mockBack, canGoBack: () => true }),
    useFocusEffect: (callback: () => void | (() => void)) => callback(),
  };
});

jest.mock("@/lib/queries/use-computer-integrations", () => ({
  useComputerIntegrations: () => mockUseComputerIntegrations(),
}));

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking } from "react-native";

import AppsConnectAppsScreen from "../app/(drawer)/(tabs)/(apps)/integrations";
import ConnectAppsSettingsScreen from "../app/settings-detail/connect-apps";
import SettingsDetailLayout from "../app/settings-detail/_layout";
import { connectAppsReturnPath, noteConnectAppsSignIn } from "../lib/connect-apps-return";
import { MOBILE_INTEGRATIONS_REDIRECT_URI } from "../lib/requests/integrations";

describe("Connect Apps in Settings", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComputerIntegrations.mockReturnValue({
      available: [{ id: "github", name: "GitHub", category: "developer", icon: "github" }],
      connected: [],
      isPending: false,
      isError: false,
      startConnection: jest.fn(),
      syncConnections: jest.fn(),
      refresh: jest.fn(),
      connectingServiceId: null,
    });
  });

  it("opens as a settings page named Connect Apps that goes back to Settings", () => {
    render(<SettingsDetailLayout />);

    const options = mockScreens["connect-apps"]?.options;
    expect(options?.title).toBe("Connect Apps");
    const HeaderLeft = options?.headerLeft as () => React.ReactElement;
    render(<HeaderLeft />);
    fireEvent.press(screen.getByLabelText("Back to settings"));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("shows the same apps to connect as the Apps tab, under the settings header instead of its own", () => {
    render(<ConnectAppsSettingsScreen />);

    expect(screen.queryByTestId("page-heading")).toBeNull();
    expect(screen.getByLabelText("View installed integrations")).toBeTruthy();
    expect(screen.getByPlaceholderText("Search apps")).toBeTruthy();
    expect(screen.getByLabelText("Connect GitHub integration")).toBeTruthy();
  });

  it("keeps the Apps tab's own heading, where no header names the screen", () => {
    render(<AppsConnectAppsScreen />);

    expect(screen.getByTestId("page-heading")).toBeTruthy();
    expect(screen.getByText("Connect Apps")).toBeTruthy();
    expect(screen.getByLabelText("Connect GitHub integration")).toBeTruthy();
  });

  it.each([
    ["Settings", ConnectAppsSettingsScreen, "/settings-detail/connect-apps"],
    ["the Apps tab", AppsConnectAppsScreen, MOBILE_INTEGRATIONS_REDIRECT_URI],
  ])("brings a sign-in begun in %s back to where it began", async (_place, Screen, landing) => {
    noteConnectAppsSignIn(Screen === AppsConnectAppsScreen ? "settings" : "apps");
    const openURL = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    mockUseComputerIntegrations.mockReturnValue({
      ...mockUseComputerIntegrations(),
      startConnection: jest.fn().mockResolvedValue("https://pipedream.example/connect"),
    });
    render(<Screen />);

    fireEvent.press(screen.getByLabelText("Connect GitHub integration"));

    await waitFor(() => expect(openURL).toHaveBeenCalledWith("https://pipedream.example/connect"));
    expect(connectAppsReturnPath(MOBILE_INTEGRATIONS_REDIRECT_URI)).toBe(landing);
  });

  it("opens the installed integrations from Settings too", () => {
    render(<ConnectAppsSettingsScreen />);

    fireEvent.press(screen.getByLabelText("View installed integrations"));

    expect(mockPush).toHaveBeenCalledWith("/integrations-installed");
  });
});
