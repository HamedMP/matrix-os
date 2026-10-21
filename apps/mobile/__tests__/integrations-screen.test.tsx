const mockPush = jest.fn();
const mockBack = jest.fn();
const mockUseComputerIntegrations = jest.fn();
const mockRefreshConnection = jest.fn();
const mockDeleteConnection = jest.fn();
const mockStartConnection = jest.fn();
const mockGmailConnectionOptions = jest.fn();
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
  useRouter: () => ({ push: mockPush, back: mockBack, canGoBack: () => true }),
  useFocusEffect: (callback: () => void | (() => void)) => callback(),
}));

jest.mock("@/lib/queries/use-computer-integrations", () => ({
  useComputerIntegrations: () => mockUseComputerIntegrations(),
}));

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { AppState, Linking, RefreshControl, StyleSheet as NativeStyleSheet } from "react-native";

import IntegrationsScreen from "../app/(drawer)/(tabs)/(apps)/integrations";
import InstalledIntegrationsScreen from "../app/integrations-installed/index";
import { ToastHost } from "../components/ui/Toast";

describe("drawer integrations screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseComputerIntegrations.mockReturnValue({
      connectionContextKey: "owner:computer",
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
      gmailConnectionOptions: mockGmailConnectionOptions,
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

    act(() => screen.UNSAFE_getByType(RefreshControl).props.onRefresh());

    expect(mockRefreshIntegrations).toHaveBeenCalledTimes(1);
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(true);

    await act(async () => resolveRefresh?.());
    expect(screen.UNSAFE_getByType(RefreshControl).props.refreshing).toBe(false);
  });

  it("returns to Apps from the back button in its top bar", () => {
    render(<IntegrationsScreen />);

    fireEvent.press(screen.getByRole("button", { name: "Back" }));

    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it("uses spacers instead of vertical padding or margins", () => {
    render(<IntegrationsScreen />);

    const styles = [
      screen.getByLabelText("View installed integrations").props.style,
      screen.getByText("2 connected accounts").props.style,
      screen.getByText("Communication").props.style,
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

  it("searches apps and filters connected apps using the shared catalog", () => {
    render(<IntegrationsScreen />);
    fireEvent.changeText(screen.getByLabelText("Search apps"), "email");
    expect(screen.getByLabelText("Connect Gmail integration")).toBeTruthy();
    expect(screen.queryByLabelText("Connect GitHub integration")).toBeNull();
    fireEvent.changeText(screen.getByLabelText("Search apps"), "");
    fireEvent.press(screen.getByText("Connected"));
    expect(screen.getByLabelText("Connect GitHub integration")).toBeTruthy();
    expect(screen.queryByLabelText("Connect Gmail integration")).toBeNull();
  });

  it("lists available services and connected accounts from the computer", () => {
    render(<IntegrationsScreen />);

    expect(screen.getByText("2 connected accounts")).toBeTruthy();
    expect(screen.getByLabelText("Connect GitHub integration")).toBeTruthy();
    expect(screen.getByLabelText("Connect Gmail integration")).toBeTruthy();

    render(<InstalledIntegrationsScreen />);

    // One row per connected account, each titled with the service name.
    expect(screen.getAllByText("GitHub")).toHaveLength(2);
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

  it.each(["matrix", "pipedream"])("lets a pilot user explicitly connect Gmail with %s", async method => {
    mockGmailConnectionOptions.mockResolvedValue({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    mockStartConnection.mockResolvedValue("https://pipedream.com/connect/test");
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    fireEvent.press(await screen.findByLabelText(method === "matrix" ? "Connect with Matrix (internal preview)" : "Connect with Pipedream"));
    await waitFor(() => expect(mockStartConnection).toHaveBeenCalledWith("gmail", { connectionMethod: method, onAttempt: expect.any(Function) }));
    view.unmount(); open.mockRestore();
  });
  it.each(["timestamp", "status"])("clears same-ID Gmail reauthorization progress after %s recovery", async recovery => {
    const account = { id: "gmail-work", service: "gmail", accountLabel: "Work", accountEmail: "work@example.invalid", status: "active", connectedAt: "2026-10-01T10:00:00.000Z" };
    const before = recovery === "status" ? { ...account, status: "expired" } : account;
    const after = recovery === "timestamp" ? { ...account, connectedAt: "2026-10-08T10:00:00.000Z" } : account;
    const initial = { ...mockUseComputerIntegrations(), connected: [before] };
    mockUseComputerIntegrations.mockReturnValue(initial);
    mockGmailConnectionOptions.mockResolvedValue({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    mockStartConnection.mockResolvedValue("https://app.matrix-os.com/auth/gmail?state=opaque");
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    fireEvent.press(await screen.findByLabelText("Connect with Matrix (internal preview)"));
    await waitFor(() => expect(open).toHaveBeenCalled());
    expect(screen.getByTestId("integration-connect-spinner-gmail")).toBeTruthy();
    mockUseComputerIntegrations.mockReturnValue({ ...initial, connected: [after] });
    view.rerender(<IntegrationsScreen />);
    await waitFor(() => expect(screen.queryByTestId("integration-connect-spinner-gmail")).toBeNull());
    view.unmount(); open.mockRestore();
  });
  it.each(["pending", "succeeded", "expired", "unavailable"])("uses exact receipt %s without inventory fallback", async state => {
    jest.useFakeTimers();
    const oldState = AppState.currentState;
    AppState.currentState = "active";
    const attemptId = "123e4567-e89b-42d3-a456-426614174000";
    const account = { id: attemptId, service: "gmail", accountLabel: "Work", accountEmail: "work@example.invalid", status: "active", connectedAt: "2026-10-01T10:00:00Z" };
    const read = jest.fn(async () => { if (state === "unavailable") throw new Error("Unavailable"); return { status: state, accountId: attemptId }; });
    const initial = { ...mockUseComputerIntegrations(), connected: [account], readConnectionAttempt: read };
    mockUseComputerIntegrations.mockReturnValue(initial);
    mockGmailConnectionOptions.mockResolvedValue({ methods: ["pipedream"], defaultMethod: "pipedream" });
    mockStartConnection.mockImplementation(async (_service, options) => { options.onAttempt(attemptId); return "https://pipedream.com/connect/test"; });
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    await act(async () => {});
    mockSyncConnections.mockClear();
    mockUseComputerIntegrations.mockReturnValue({ ...initial, connected: [{ ...account, connectedAt: "2099-01-01" }] });
    view.rerender(<IntegrationsScreen />);
    expect(screen.getByTestId("integration-connect-spinner-gmail")).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(2_000); });
    expect(read).toHaveBeenCalledWith(attemptId);
    if (state === "pending") expect(screen.getByTestId("integration-connect-spinner-gmail")).toBeTruthy();
    else expect(screen.queryByTestId("integration-connect-spinner-gmail")).toBeNull();
    view.unmount(); open.mockRestore(); AppState.currentState = oldState; jest.useRealTimers();
  });
  it("cancels Gmail choice without a consent request", async () => {
    mockGmailConnectionOptions.mockResolvedValue({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    await screen.findByLabelText("Connect with Pipedream");
    fireEvent.press(screen.getByLabelText("Cancel Gmail connection"));
    expect(mockStartConnection).not.toHaveBeenCalled();
  });
  it("shows safe discovery failure and a retry instead of native choice", async () => {
    mockGmailConnectionOptions.mockRejectedValue(new Error("private failure"));
    render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    expect(await screen.findByText("Could not load Gmail connection options. Try again.")).toBeTruthy();
    expect(screen.queryByLabelText("Connect with Matrix (internal preview)")).toBeNull();
    fireEvent.press(screen.getByLabelText("Retry Gmail connection options"));
    await waitFor(() => expect(mockGmailConnectionOptions).toHaveBeenCalledTimes(2));
    expect(mockStartConnection).not.toHaveBeenCalled();
  });

  it("ignores late discovery after cancellation", async () => {
    let resolve!: (value: unknown) => void;
    mockGmailConnectionOptions.mockReturnValue(new Promise(value => { resolve = value; }));
    render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    fireEvent.press(screen.getByLabelText("Cancel Gmail connection"));
    await act(async () => resolve({ methods: ["pipedream"], defaultMethod: "pipedream" }));
    expect(mockStartConnection).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Connect with Matrix (internal preview)")).toBeNull();
  });
  it("does not start parallel consent requests for repeated method presses", async () => {
    mockGmailConnectionOptions.mockResolvedValue({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    mockStartConnection.mockReturnValue(new Promise(() => {}));
    render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    const choice = await screen.findByLabelText("Connect with Pipedream");
    fireEvent.press(choice); fireEvent.press(choice);
    expect(mockStartConnection).toHaveBeenCalledTimes(1);
  });
  it("discards previous runtime capability discovery", async () => {
    let resolve!: (value: unknown) => void;
    mockGmailConnectionOptions.mockReturnValue(new Promise(value => { resolve = value; }));
    const view = render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    mockUseComputerIntegrations.mockReturnValue({ ...mockUseComputerIntegrations(), connectionContextKey: "owner:next-computer" });
    view.rerender(<IntegrationsScreen />);
    await act(async () => resolve({ methods: ["pipedream"], defaultMethod: "pipedream" }));
    expect(mockStartConnection).not.toHaveBeenCalled();
  });

  it("does not open consent minted for a previous runtime", async () => {
    let resolve!: (value: string) => void;
    mockGmailConnectionOptions.mockResolvedValue({ methods: ["matrix", "pipedream"], defaultMethod: "matrix" });
    mockStartConnection.mockReturnValue(new Promise(value => { resolve = value; }));
    const open = jest.spyOn(Linking, "openURL").mockResolvedValue(true);
    const view = render(<IntegrationsScreen />);
    fireEvent.press(screen.getByLabelText("Connect Gmail integration"));
    fireEvent.press(await screen.findByLabelText("Connect with Matrix (internal preview)"));
    mockUseComputerIntegrations.mockReturnValue({ ...mockUseComputerIntegrations(), connectionContextKey: "owner:next-computer" });
    view.rerender(<IntegrationsScreen />);
    await act(async () => resolve("https://app.matrix-os.com/auth/gmail?state=old"));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
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

  it("says so with a toast once a connection is deleted", async () => {
    mockDeleteConnection.mockResolvedValue(undefined);
    render(<><InstalledIntegrationsScreen /><ToastHost /></>);

    fireEvent.press(screen.getByLabelText("Delete Work GitHub connection"));
    await act(async () => fireEvent.press(screen.getByLabelText("Confirm delete connection")));

    expect(screen.getByText("Connection deleted")).toBeTruthy();
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
