import React from "react";
import { render, waitFor } from "@testing-library/react-native";
import AppsScreen from "../app/(tabs)/apps";
import { useGateway } from "../app/_layout";
import { GatewayClient } from "../lib/gateway-client";

jest.mock("../app/_layout", () => ({
  useGateway: jest.fn(),
}));

jest.mock("expo-router", () => {
  const React = require("react");
  return {
    Link: ({ children }: { children: React.ReactElement }) => children,
  };
});

jest.mock("expo-image", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Image: (props: Record<string, unknown>) => React.createElement(View, { ...props, testID: "app-image" }),
  };
});

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
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("keeps native Matrix apps visible before a gateway client is connected", async () => {
    useGatewayMock.mockReturnValue(gatewayContext({}));

    const { getByText } = render(<AppsScreen />);

    await waitFor(() => expect(getByText("Chat")).toBeTruthy());
    expect(getByText("Apps")).toBeTruthy();
    expect(getByText("Tasks")).toBeTruthy();
    expect(getByText("Settings")).toBeTruthy();
  });

  it("keeps native Matrix apps visible when the gateway returns no apps", async () => {
    const client = new GatewayClient("https://app.matrix-os.com");
    const getApps = jest.spyOn(client, "getApps").mockResolvedValue([]);
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "connected",
    }));

    const { getByText } = render(<AppsScreen />);

    await waitFor(() => expect(getApps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText("Chat")).toBeTruthy());
    expect(getByText("Tasks")).toBeTruthy();
  });

  it("keeps native Matrix apps visible when the gateway app fetch fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GatewayClient("https://app.matrix-os.com");
    const getApps = jest.spyOn(client, "getApps").mockRejectedValue(new Error("gateway unavailable"));
    useGatewayMock.mockReturnValue(gatewayContext({
      client,
      connectionState: "error",
    }));

    const { getByText } = render(<AppsScreen />);

    await waitFor(() => expect(getApps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText("Chat")).toBeTruthy());
    expect(getByText("Settings")).toBeTruthy();

    warn.mockRestore();
  });
});
