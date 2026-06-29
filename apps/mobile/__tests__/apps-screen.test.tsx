jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

jest.mock("../app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => {
      const mockReact = require("react");
      return mockReact.createElement(View, { testID: "expo-image", ...props });
    },
  };
});

import React from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AppsScreen from "../app/(tabs)/apps";
import { useGateway } from "../app/_layout";
import { GatewayClient } from "../lib/gateway-client";
import { MOBILE_SHELL_STATE_STORAGE_KEY } from "../lib/mobile-shell-state";

const useGatewayMock = useGateway as jest.MockedFunction<typeof useGateway>;
type GatewayContextValue = ReturnType<typeof useGateway>;

function gatewayContext(overrides: Partial<GatewayContextValue>): GatewayContextValue {
  return {
    client: null,
    connectionState: "disconnected",
    gateway: null,
    setGateway: jest.fn(),
    unreadCount: 0,
    incrementUnread: jest.fn(),
    clearUnread: jest.fn(),
    ...overrides,
  };
}

describe("AppsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
    jest.mocked(AsyncStorage.setItem).mockResolvedValue();
  });

  it("keeps native Matrix apps visible before a gateway client is connected", async () => {
    useGatewayMock.mockReturnValue(gatewayContext({}));

    render(<AppsScreen />);

    await waitFor(() => expect(screen.getByText("Chat")).toBeTruthy());
    // "Apps" appears twice now: the screen title and the native Apps card.
    expect(screen.getAllByText("Apps").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Tasks")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
  });

  it("keeps native Matrix apps visible when the gateway returns no apps", async () => {
    const client = new GatewayClient("https://app.matrix-os.com");
    const getApps = jest.spyOn(client, "getApps").mockResolvedValue([]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(getApps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Chat")).toBeTruthy());
    expect(screen.getByText("Tasks")).toBeTruthy();
  });

  it("keeps native Matrix apps visible when the gateway app fetch fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GatewayClient("https://app.matrix-os.com");
    const getApps = jest.spyOn(client, "getApps").mockRejectedValue(new Error("gateway unavailable"));
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "error",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(getApps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Chat")).toBeTruthy());
    expect(screen.getByText("Settings")).toBeTruthy();

    warn.mockRestore();
  });

  it("offers a real continue card for the last active app and updates persisted state when used", async () => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify({
      mode: "app",
      lastActiveAppSlug: "notes",
      updatedAt: "2026-05-13T00:00:00.000Z",
    }));
    const client = new GatewayClient("https://app.matrix-os.test");
    jest.spyOn(client, "getApps").mockResolvedValue([
      {
        name: "Notes",
        description: "Write and organize notes.",
        category: "Productivity",
        file: "notes/index.html",
        path: "/files/apps/notes/index.html",
        slug: "notes",
      },
    ]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    render(<AppsScreen />);

    await waitFor(() => expect(screen.getByLabelText("Continue Notes")).toBeTruthy());
    fireEvent.press(screen.getByLabelText("Continue Notes"));

    await waitFor(() => expect(AsyncStorage.setItem).toHaveBeenCalledWith(
      MOBILE_SHELL_STATE_STORAGE_KEY,
      expect.stringContaining("\"lastActiveAppSlug\":\"notes\""),
    ));
  });
});
