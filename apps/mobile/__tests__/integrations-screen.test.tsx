const mockPush = jest.fn();
const mockUseComputerIntegrations = jest.fn();
const mockRefreshConnection = jest.fn();
const mockDeleteConnection = jest.fn();
const mockStartConnection = jest.fn();
const mockSyncConnections = jest.fn();
const mockRefreshIntegrations = jest.fn();
const mockSwipeableClose = jest.fn();

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { View } = require("react-native");
  return {
    Swipeable: React.forwardRef(function MockSwipeable(
      { children, renderRightActions }: { children: React.ReactNode; renderRightActions?: () => React.ReactNode },
      ref: React.ForwardedRef<unknown>,
    ) {
      React.useImperativeHandle(ref, () => ({ close: mockSwipeableClose }));
      return <View>{children}{renderRightActions?.()}</View>;
    }),
  };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
  useFocusEffect: (callback: () => void | (() => void)) => callback(),
}));

jest.mock("@/lib/queries/use-computer-integrations", () => ({
  useComputerIntegrations: () => mockUseComputerIntegrations(),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Linking, StyleSheet as NativeStyleSheet } from "react-native";

import IntegrationsScreen from "../app/(drawer)/integrations";
import InstalledIntegrationsScreen from "../app/integrations-installed/index";

describe("drawer integrations screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComputerIntegrations.mockReturnValue({
      available: [
        { id: "github", name: "GitHub", category: "developer", icon: "github" },
        { id: "gmail", name: "Gmail", category: "google", icon: "mail" },
      ],
      connected: [
        {
          id: "connection-1",
          service: "github",
          accountLabel: "Work",
          accountEmail: "dev@example.com",
          status: "active",
          connectedAt: "2026-08-31T10:00:00.000Z",
        },
        {
          id: "connection-2",
          service: "github",
          accountLabel: "Personal",
          accountEmail: null,
          status: "active",
          connectedAt: "2026-08-31T11:00:00.000Z",
        },
      ],
      isPending: false,
      isError: false,
      refreshConnection: mockRefreshConnection,
      deleteConnection: mockDeleteConnection,
      startConnection: mockStartConnection,
      syncConnections: mockSyncConnections,
      refresh: mockRefreshIntegrations,
      isMutating: false,
      refreshingConnectionId: null,
      deletingConnectionId: null,
    });
  });

  it("holds the native refresh control open until integrations finish refreshing", async () => {
    let resolveRefresh: (() => void) | undefined;
    mockRefreshIntegrations.mockReturnValue(new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    render(<IntegrationsScreen />);

    act(() => screen.getByTestId("page-refresh-control").props.onRefresh());

    expect(mockRefreshIntegrations).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("page-refresh-control").props.refreshing).toBe(true);

    await act(async () => resolveRefresh?.());
    expect(screen.getByTestId("page-refresh-control").props.refreshing).toBe(false);
  });

  it("uses spacers instead of vertical padding or margins", () => {
    render(<IntegrationsScreen />);

    const styles = [
      screen.getByLabelText("View installed integrations").props.style,
      screen.getByText("2 connected accounts").props.style,
      screen.getByText("AVAILABLE").props.style,
      screen.getByLabelText("Connect GitHub integration").props.style,
    ].map(NativeStyleSheet.flatten);

    for (const style of styles) {
      expect(style.paddingTop).toBeUndefined();
      expect(style.paddingBottom).toBeUndefined();
      expect(style.paddingVertical).toBeUndefined();
      expect(style.marginTop).toBeUndefined();
      expect(style.marginBottom).toBeUndefined();
      expect(style.marginVertical).toBeUndefined();
    }
  });

  it("lists available services and connected accounts from the computer", () => {
    render(<IntegrationsScreen />);

    expect(screen.getByText("2 connected accounts")).toBeTruthy();
    expect(screen.getByLabelText("Connect GitHub integration")).toBeTruthy();
    expect(screen.getByLabelText("Connect Gmail integration")).toBeTruthy();

    render(<InstalledIntegrationsScreen />);

    expect(screen.getAllByText("GitHub")).toHaveLength(3);
    expect(screen.getByText("dev@example.com")).toBeTruthy();
    expect(screen.getByText("Personal")).toBeTruthy();
    expect(screen.queryByText("GitHub · dev@example.com · active")).toBeNull();
    expect(screen.queryByLabelText("Open Work GitHub connection")).toBeNull();
  });

  it("opens available integrations in the device browser with an app return link", async () => {
    mockStartConnection.mockResolvedValue(
      "https://pipedream.com/connect/project?token=connect-token&app=github",
    );
    mockSyncConnections.mockResolvedValue(undefined);
    const openUrl = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = render(<IntegrationsScreen />);

    fireEvent.press(screen.getByLabelText("Connect GitHub integration"));

    await waitFor(() => {
      expect(mockStartConnection).toHaveBeenCalledWith("github");
      expect(openUrl).toHaveBeenCalledWith(
        "https://pipedream.com/connect/project?token=connect-token&app=github",
      );
    });
    view.unmount();
    openUrl.mockRestore();
  });

  it("refreshes and confirmation-deletes connected accounts from swipe actions", () => {
    mockRefreshConnection.mockResolvedValue(undefined);
    mockDeleteConnection.mockResolvedValue(undefined);
    render(<InstalledIntegrationsScreen />);

    fireEvent.press(screen.getByLabelText("Refresh Work GitHub connection"));
    expect(mockRefreshConnection).toHaveBeenCalledWith("connection-1");

    fireEvent.press(screen.getByLabelText("Delete Work GitHub connection"));
    expect(screen.getByText("Delete connection?")).toBeTruthy();
    expect(mockDeleteConnection).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Confirm delete connection"));
    expect(mockDeleteConnection).toHaveBeenCalledWith("connection-1");
  });

  it("replaces the refresh glyph with a spinner for the refreshing connection", () => {
    mockUseComputerIntegrations.mockReturnValue({
      ...mockUseComputerIntegrations(),
      isMutating: true,
      refreshingConnectionId: "connection-1",
    });

    render(<InstalledIntegrationsScreen />);

    expect(screen.getByTestId("integration-refresh-spinner-connection-1")).toBeTruthy();
    expect(screen.queryByTestId("integration-refresh-icon-connection-1")).toBeNull();
    expect(screen.getByTestId("integration-refresh-icon-connection-2")).toBeTruthy();
  });

  it("replaces the delete glyph with a spinner for the deleting connection", () => {
    mockUseComputerIntegrations.mockReturnValue({
      ...mockUseComputerIntegrations(),
      isMutating: true,
      deletingConnectionId: "connection-1",
    });

    render(<InstalledIntegrationsScreen />);

    expect(screen.getByTestId("integration-delete-spinner-connection-1")).toBeTruthy();
    expect(screen.queryByTestId("integration-delete-icon-connection-1")).toBeNull();
    expect(screen.getByTestId("integration-delete-icon-connection-2")).toBeTruthy();
  });

  it("keeps the swipe open during refresh and closes it after success", async () => {
    let resolveRefresh: (() => void) | undefined;
    mockRefreshConnection.mockReturnValue(new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    render(<InstalledIntegrationsScreen />);

    fireEvent.press(screen.getByLabelText("Refresh Work GitHub connection"));
    expect(mockSwipeableClose).not.toHaveBeenCalled();

    await act(async () => resolveRefresh?.());
    await waitFor(() => expect(mockSwipeableClose).toHaveBeenCalledTimes(1));
  });

  it("closes the popup on delete but waits for the endpoint before resetting the swipe", async () => {
    let resolveDelete: (() => void) | undefined;
    mockDeleteConnection.mockReturnValue(new Promise<void>((resolve) => {
      resolveDelete = resolve;
    }));
    render(<InstalledIntegrationsScreen />);

    fireEvent.press(screen.getByLabelText("Delete Work GitHub connection"));
    expect(mockSwipeableClose).not.toHaveBeenCalled();

    fireEvent.press(screen.getByLabelText("Cancel"));
    expect(mockSwipeableClose).toHaveBeenCalledTimes(1);

    mockSwipeableClose.mockClear();
    fireEvent.press(screen.getByLabelText("Delete Work GitHub connection"));
    fireEvent.press(screen.getByLabelText("Confirm delete connection"));

    expect(screen.queryByText("Delete connection?")).toBeNull();
    expect(mockSwipeableClose).not.toHaveBeenCalled();
    expect(mockDeleteConnection).toHaveBeenCalledWith("connection-1");

    await act(async () => resolveDelete?.());
    await waitFor(() => expect(mockSwipeableClose).toHaveBeenCalledTimes(1));
  });
});
